import { appendFileSync, mkdirSync } from 'node:fs';
import { Agent, MAX_STEPS, type TurnRecord } from './agent.js';
import { createImageHydrator, worthAnswering } from './bluebubbles/attachments.js';
import { BlueBubblesClient } from './bluebubbles/client.js';
import { Presence } from './bluebubbles/presence.js';
import { BlueBubblesConnector, BlueBubblesReceiver, parseSendAudience } from './bluebubbles/receiver.js';
import { SeenStore } from './bluebubbles/seen.js';
import { ChoiceStore } from './choices.js';
import {
  presenceToken,
  sendToken,
  withPresence,
  joinBurstText,
  mergeAttachmentsRaw,
  type IncomingMessage,
  type PresenceRecord,
  type SendRecord,
} from './connector.js';
import { BURST_SETTLE_MS, sleep, TurnQueue, type BatchWait } from './turn-queue.js';
import {
  failureReply,
  MAX_NOTICES,
  parseStillWorkingMs,
  StillWorkingNotice,
  STILL_WORKING_AFTER_MS,
} from './turn-notice.js';
import { REPLY_THREADING_ENABLED, ReplyThreading } from './bluebubbles/threading.js';
import { assertShellIdentityIsSafe, loadConfig } from './config.js';
import { FollowupStore } from './followups.js';
import { InviteLedger } from './invite-ledger.js';
import { JfagoClient } from './jfago.js';
import { AbsClient } from './audiobookshelf.js';
import { runDueFollowups } from './followup-runner.js';
import { proveShellIdentityIsSafe } from './identity-probe.js';
import { KindleRegistry } from './kindle.js';
import { IrcEbooks } from './media/irc-ebooks.js';
import { DEFAULT_MOUNTS } from './tools/send-ebook.js';
import { realMailSender } from './media/kindle-send.js';
import { imapMailboxReader, imapSettingsFrom } from './kindle-mailbox.js';
import { createLlmClient, probeLlm, TURN_TIMEOUT_MS } from './llm.js';
import { HistoryStore } from './store.js';
import { buildTools } from './tools/index.js';

/**
 * LIVE MODE — V2 on iMessage, replying as Jedd.
 *
 * ── 🔴 THIS IS THE FILE THAT SENDS. READ THE THREE GATES BEFORE STARTING IT. ─
 *
 * `shadow-main.ts` cannot text anybody: it holds no client, its connector has no
 * send path, and it refuses to start with writes on. **None of that is true
 * here.** This process answers real people on Jeff's household thread, from
 * Jedd's Apple ID, and the messages it sends cannot be recalled.
 *
 *  1. **`JEDD_SEND_TO` is required.** `everyone` is the cutover value; a
 *     comma-separated handle list is the rehearsal value. There is no default —
 *     an unset variable refuses to start rather than picking the permissive
 *     reading for somebody who did not think about it.
 *  2. **The identity assertion runs before anything is served.** Ports 1234 and
 *     1235 share a password and an API shape, so a copy-pasted `.env` connects
 *     *successfully* to Jeff's personal iMessage. It throws; nothing catches it.
 *  3. **The webhook is deregistered on the way out.** A Ctrl-C that leaves a row
 *     pointing at a dead port is the 1.4.11 orphan: BlueBubbles delivers into a
 *     black hole and nothing fails loudly. Shutdown is part of the contract, not
 *     a courtesy.
 *
 * ⚠️ Starting this does NOT stop V1. V1 keeps running with its own webhook until
 * somebody deletes that row deliberately — see the cutover runbook. Registration
 * here will not touch it: a row on a different port belongs to somebody else.
 */

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

function recordTurn(record: TurnRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(`${DATA_DIR}audit.jsonl`, `${JSON.stringify(record)}\n`, 'utf8');
}

/** How often to look for follow-ups that have come due. */
const TICK_MS = 60_000;

/**
 * The newest guid in a burst, for a reply that has to name a message.
 *
 * ⚠️ NEWEST-THAT-HAS-ONE, not simply newest. `sourceGuid` is optional on
 * `IncomingMessage` — a transport that cannot name a message leaves it unset —
 * so a burst whose LAST message lacks a guid still has an anchorable earlier
 * one, and taking the last unconditionally would discard it. Returns an empty
 * object so it can be spread over a message without inventing an `undefined`
 * field on a type where absent and undefined mean the same thing.
 */
function anchorFrom(batch: IncomingMessage[]): { sourceGuid?: string } {
  for (let i = batch.length - 1; i >= 0; i--) {
    const guid = batch[i]?.sourceGuid;
    if (guid) return { sourceGuid: guid };
  }
  return {};
}

async function main(): Promise<void> {
  const config = loadConfig();
  /** See `parseStillWorkingMs`: overridable so the notice can be made to fire on demand. */
  const stillWorkingMs = parseStillWorkingMs(process.env['JEDD_STILL_WORKING_MS']) ?? STILL_WORKING_AFTER_MS;
  // 🔴 First, before a socket is opened or a webhook registered. A refusal here
  // must cost nothing and leave nothing behind.
  const audience = parseSendAudience(process.env['JEDD_SEND_TO']);

  const client = new BlueBubblesClient({
    baseUrl: config.bluebubbles.baseUrl,
    password: config.bluebubbles.password,
    expectedIdentity: config.bluebubbles.expectedIdentity,
  });
  const info = await client.assertIdentity();
  console.error(`[jedd] BlueBubbles ${info.serverVersion} bridging ${info.detectedIMessage}`);
  /**
   * 🔴 THE ONE LINE THAT SAYS WHETHER DISABLING SIP WORKED.
   *
   * Typing indicators and read receipts need the helper bundle, and the failure
   * is otherwise completely silent by design — `Presence` swallows it so it can
   * never touch a reply. Silence is the right behaviour and the wrong diagnostic,
   * so the state is stated once at boot where somebody looking for it will find
   * it.
   *
   * ⚠️ BOTH FLAGS, NOT ONE. `private_api` is the setting; `helper_connected` is
   * whether the dylib actually loaded. On 2026-08-25 they read `true` and
   * `false` — the setting alone would have said the feature was on.
   */
  console.error(
    info.helperConnected
      ? '[jedd] presence: typing indicators and read receipts are LIVE (private api on, helper connected).'
      : `[jedd] presence: typing indicators and read receipts are OFF — private_api=${info.privateApiEnabled}, ` +
        'helper_connected=false. Needs SIP disabled and the BlueBubbles helper bundle installed. ' +
        'Nothing else is affected; the calls fail in ~3ms and are swallowed.',
  );
  console.error(
    audience === 'everyone'
      ? '[jedd] 🔴 SEND AUDIENCE: everyone — this is a real cutover, not a rehearsal.'
      : `[jedd] SEND AUDIENCE: ${audience.join(', ')} — everyone else gets SILENCE.`,
  );

  const llm = createLlmClient(config);
  /**
   * 🔴 THE MODEL IS REQUIRED FOR FUNCTION AND IS CHECKED NOWHERE ELSE.
   *
   * Nothing contacts it before serving, so an unreachable endpoint is invisible
   * until the first message — and then every turn throws while the process stays
   * up and healthy. Awaited on purpose (it is one 5s-capped call) so the verdict
   * appears ABOVE the tool line, where somebody reading a boot log will see it.
   *
   * Warned, never fatal: reachability is not config presence. See probeLlm.
   */
  const llmProbe = await probeLlm(config);
  if (llmProbe.ok) {
    console.error(`[jedd] model OK: ${llmProbe.detail}`);
  } else {
    console.error(`[jedd] 🔴 THE MODEL IS NOT USABLE: ${llmProbe.detail}`);
    console.error(
      `[jedd] 🔴 Every turn will fail and each sender gets an error reply, not an answer. ` +
        `Fix LLM_BASE_URL (currently ${config.llm.baseUrl}) or LLM_MODEL (${config.llm.model}).`,
    );
    /**
     * ⚠️ NAMED EXPLICITLY BECAUSE THE DEFAULT IS WRONG BY CONSTRUCTION FOR THE
     * MOST LIKELY DEPLOYMENT. `localhost` inside a container is THE CONTAINER —
     * so the shipped default cannot work for anyone running this the documented
     * way, and it fails looking configured rather than looking unset.
     */
    if (/^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(config.llm.baseUrl)) {
      console.error(
        `[jedd] 🔴 LLM_BASE_URL points at localhost. IN A CONTAINER THAT IS THE CONTAINER ITSELF, ` +
          `not the machine running the model. Use host.docker.internal (Docker Desktop) or the ` +
          `host's LAN address.`,
      );
    }
  }
  const preflight = assertShellIdentityIsSafe(config);
  const shellIdentity = preflight.safe
    ? await proveShellIdentityIsSafe(config)
    : { safe: false, reason: preflight.reason, evidence: ['pre-flight refused; probe not attempted'] };

  const history = new HistoryStore(`${DATA_DIR}history.jsonl`);
  const followups = new FollowupStore(`${DATA_DIR}followups.jsonl`);
  const choices = new ChoiceStore(`${DATA_DIR}choices.jsonl`);
  const kindle = new KindleRegistry(`${DATA_DIR}kindle.jsonl`);
  const seen = new SeenStore(`${DATA_DIR}seen.jsonl`);
  const invites = new InviteLedger(`${DATA_DIR}invites.jsonl`);
  const absInvites = new InviteLedger(`${DATA_DIR}abs-invites.jsonl`);

  /**
   * 🔴 ONE tracker, shared by the receiver that sees the messages arrive and the
   * connector that sends the replies. Two instances would each hold half the
   * facts and no burst would ever be counted.
   */
  const threading = REPLY_THREADING_ENABLED ? new ReplyThreading() : undefined;
  console.error(
    REPLY_THREADING_ENABLED
      ? '[jedd] reply-threading ON: a reply is quoted to its message when more than one is owed.'
      : '[jedd] 🔴 reply-threading OFF — anchors were faithful to the TRIGGER but turns answer each ' +
          "other's questions, so every quote pointed at the wrong message. See threading.ts.",
  );

  /**
   * Inbound images.
   *
   * ⚠️ The BOUNDS live here, on the one object both the fetch and the burst
   * joiner read. They were two numbers in two files during development and the
   * per-turn cap and the per-message cap immediately disagreed — a burst was
   * capped at one number and each message at another, so the effective limit was
   * whichever ran last.
   */
  const imageLimits = {
    maxWidth: config.images.maxWidth,
    maxBytes: config.images.maxBytes,
    maxCount: config.images.maxCount,
  };
  const hydrateAttachments = createImageHydrator({
    baseUrl: config.bluebubbles.baseUrl,
    password: config.bluebubbles.password,
    limits: imageLimits,
  });
  console.error(
    `[jedd] inbound images ON: up to ${imageLimits.maxCount} per turn, resized to ` +
      `${imageLimits.maxWidth}px by the BlueBubbles server, ceiling ` +
      `${Math.round(imageLimits.maxBytes / 1024 / 1024)} MB each.`,
  );

  const receiver = new BlueBubblesReceiver({
    client,
    seen,
    // From the server, not from config: the loop guard must compare against the
    // account BlueBubbles is actually signed in as.
    selfIdentity: info.detectedIMessage,
    threading,
    host: config.bluebubbles.host,
    port: config.bluebubbles.port,
    path: config.bluebubbles.path,
    onSkipped: (v) => {
      if (v.action === 'skip') console.error(`[jedd] skipped rowid ${v.rowid}: ${v.reason}`);
    },
  });

  /**
   * Typing indicators and read receipts.
   *
   * ⚠️ REQUIRES THE BLUEBUBBLES PRIVATE API HELPER, WHICH NEEDS SIP DISABLED.
   * As of 2026-08-25 `server/info` reports `private_api: true` but
   * `helper_connected: false`, so every one of these calls returns HTTP 500 in
   * ~3ms and nothing appears on anybody's phone. That is the expected state, it
   * is handled, and it is invisible: `Presence` swallows it and says so once.
   * Nothing else about this process changes when it starts working.
   */
  /**
   * 🔴 THE CEILING IS DERIVED FROM THE RESOLVED BUDGET, NOT THE CONSTANT.
   *
   * `CEILING_MS` is `TURN_TIMEOUT_MS * MAX_STEPS`, and `llm.ts` says the two are
   * coupled on purpose: they were independent magic numbers once and the typing
   * indicator died at six minutes on a turn that ran 787 seconds and completed
   * fine. Making the budget overridable QUIETLY BROKE that coupling —
   * `LLM_TURN_TIMEOUT_MS` moved one side and `presence.ts` still computed from
   * the other, so a raised budget reproduced the original complaint exactly.
   * Passing it explicitly is what keeps "changing one forces you past the other"
   * true now that one of them lives in the environment.
   */
  const presence = new Presence({ client, ceilingMs: (config.llm.turnTimeoutMs ?? TURN_TIMEOUT_MS) * MAX_STEPS });

  const connector = new BlueBubblesConnector(
    receiver,
    client,
    audience,
    (to, text) => console.error(`[jedd] SUPPRESSED ${text.length} chars to ${to} — not in the send audience.`),
    presence,
    threading,
  );

  /**
   * 🔴 THE INVITE SENDS THROUGH THE SAME GATED CONNECTOR AS EVERY OTHER MESSAGE.
   *
   * Two things follow, and both are load-bearing:
   *
   *  1. A rehearsal cannot leak a real invite link to somebody outside
   *     `JEDD_SEND_TO`. The audience gate is not re-implemented here; there is
   *     one send path.
   *  2. **A SUPPRESSED SEND MUST READ AS A FAILED SEND**, so the invite is
   *     revoked. `sendReporting` reports what happened; anything that is not a
   *     confirmed non-failure destroys the credential. Silently swallowing a
   *     suppression would leave a live single-use invite behind for a message
   *     nobody ever received — the exact V1 defect this tool was built to not
   *     have, reintroduced by the test harness rather than by the tool.
   */
  const invite = {
    jfago: new JfagoClient({
      baseUrl: config.jfago.baseUrl,
      inviteBaseUrl: config.jfago.inviteBaseUrl,
      username: config.jfago.username,
      password: config.jfago.password,
      profile: config.jfago.profile,
      validityHours: config.jfago.validityHours,
    }),
    ledger: invites,
    send: (to: string, text: string) => connector.sendReporting(to, text),
    // Read the transport's own history back before the tool revokes on a
    // reported failure — the 2026-09-20 false negative (500 after the text
    // landed) must not kill a working invite again.
    verifySent: (to: string, text: string) => client.recentlySent(to, text),
  };
  const absInvite = {
    abs: new AbsClient({
      baseUrl: config.audiobookshelf.baseUrl,
      apiKey: config.audiobookshelf.apiKey,
      publicUrl: config.audiobookshelf.publicUrl || config.audiobookshelf.baseUrl,
    }),
    ledger: absInvites,
    send: (to: string, text: string) => connector.sendReporting(to, text),
    verifySent: (to: string, text: string) => client.recentlySent(to, text),
  };
  /**
   * ⚠️ `send_ebook` IS RESTRICTED TO THE OWNER IN THIS BUILD.
   *
   * It is `minRole: 'guest'` by declaration and the address it mails is
   * provenance-verified per sender, so widening it is one line — delete
   * `onlySendTo`. It is narrow here because the path has had exactly ONE live
   * send ever, and this is its first exposure to real household traffic. A guest
   * who asks gets a visible refusal naming the restriction, which is the safe
   * direction: annoying beats an unrecallable email.
   */
  const ebook = { send: await realMailSender(config), onlySendTo: config.ownerHandle };

  /**
   * Reads Amazon's refusal notices out of the sending account.
   *
   * Built once at start-up so a missing credential is visible HERE, in the boot
   * log, rather than surfacing four minutes after somebody's book went out.
   */
  const imap = imapSettingsFrom(config);
  const mailbox = 'missing' in imap ? undefined : imapMailboxReader(imap);
  if (!mailbox) {
    console.warn(
      `[kindle] delivery verification is OFF: ${(imap as { missing: string }).missing} is not set. ` +
        'Books can still be sent; a refusal by Amazon will go undetected.',
    );
  }

  /**
   * The IRC #ebooks source.
   *
   * ⚠️ OFF UNLESS `IRC_EBOOKS=1`. It opens a long-lived socket to a third-party
   * network from inside this process, so it is opt-in rather than something a
   * deploy acquires by accident.
   *
   * 🔴 NOT AWAITED, AND THAT IS DELIBERATE. `connect()` costs ~70 SECONDS —
   * irchighway refuses `JOIN #ebooks` until roughly 65s after the TCP connect.
   * Blocking startup on it would delay every OTHER capability behind a network
   * this process does not control. It warms in the background; a search that
   * arrives before it is ready gets an honest "IRC is not available" and the
   * Prowlarr results, rather than a hang.
   */
  /**
   * Network, channel and nick come from config; the TIMING options deliberately
   * do not (see `Config.irc`) — they are measured properties of this server's
   * behaviour, and `IrcOptions` keeps its own defaults for them.
   *
   * `nick` matters most: two deployments on the same network collide, and the
   * second one gets renamed or rejected.
   */
  const irc =
    process.env.IRC_EBOOKS === '1'
      ? new IrcEbooks({
          host: config.irc.host,
          port: config.irc.port,
          channel: config.irc.channel,
          nick: config.irc.nick,
          log: (m) => console.error(m),
        })
      : undefined;
  if (irc) {
    /**
     * 🔴 SUCCESS AND FAILURE SHARE THE `[irc]` PREFIX. ON PURPOSE.
     *
     * This line used to read `[jedd] irc #ebooks joined`, while every problem
     * the module reports carries `[irc]`. That split cost a real, confident
     * wrong diagnosis on 2026-08-26: someone checked whether the source had run
     * by counting `[irc]` lines, got **0**, and concluded nothing IRC had
     * executed — with a VALID control (the same grep found 160 boot markers,
     * growing in step with restarts). It was working the whole time. Every
     * `[irc]` string was an error path, so a clean connection emitted none:
     * **they measured the absence of PROBLEMS and read it as the absence of the
     * FEATURE.**
     *
     * ⚠️ CONSEQUENCE, AND THE NEW RULE: `[irc]` IS NO LONGER A FAILURE COUNTER.
     * A non-zero count no longer means trouble, so do not read it as a health
     * signal. Read the OUTCOME WORD instead:
     *
     *   grep '#ebooks joined'      -> connected. One per IRC-enabled boot.
     *   grep '#ebooks UNAVAILABLE' -> tried and could not.
     *
     * ⚠️ THOSE PATTERNS DROP THE `irc` PREFIX ON PURPOSE, AND THAT IS A FIX.
     * They used to read `grep 'irc #ebooks joined'`, which matches NOTHING: the
     * line emitted below is `[irc] #ebooks joined`, so the literal `irc ` is
     * followed by `]`, not a space. The recipe written to stop someone
     * miscounting IRC health returned 0 against a healthy connection — the same
     * false zero it exists to prevent, one layer up. Confirmed 2026-08-27 while
     * diagnosing a live search failure.
     *   grep '\[irc\]' | grep -v '#ebooks' -> the problem lines only.
     *
     * The point of one prefix is that "did this run?" and "did it have trouble?"
     * are answerable with the same handle instead of requiring you to know which
     * of two prefixes the answer hides behind.
     */
    void irc
      .connect()
      .then((up) =>
        console.error(up ? `[irc] #ebooks joined — ${irc.status().detail}` : `[irc] #ebooks UNAVAILABLE — ${irc.status().detail}`),
      );
  }

  const tools = buildTools(config, shellIdentity, { invite, absInvite, ebook, ...(irc ? { irc } : {}) });
  const agent = new Agent(config, llm, recordTurn, tools, history, followups, choices, kindle);

  console.error(
    `[jedd] model=${llm.label} owner=${config.ownerHandle} ` +
      `writes=${config.readOnly ? 'DISABLED' : 'ENABLED'} hp_shell=${shellIdentity.safe ? 'on' : 'OFF'}`,
  );
  console.error(`[jedd] tools=${tools.map((t) => t.name).join(', ')}`);
  /**
   * 🔴 SAY WHAT IS OFF, AND SAY WHICH VARIABLE TURNS IT ON.
   *
   * Gating a tool out is the right behaviour — an absent tool cannot be offered
   * to somebody and then fail. But a capability that vanishes SILENTLY is the
   * same defect wearing different clothes: the operator sees a smaller bot with
   * no reason given, and "Jedd cannot restart containers" reads as a bug rather
   * than as an unset variable. The registry line above says what IS here; this
   * says what is NOT, and how to change it.
   */
  const off: string[] = [];
  if (!config.homelabSshConfigured) off.push('homelab ssh (12 docker/host tools) — set HP_ADMIN_SSH_HOST');
  else if (!shellIdentity.safe) off.push(`hp_shell — ${shellIdentity.reason}`);
  if (!config.kindle.smtpPassword) off.push('ebooks to Kindle (4 tools) — set KINDLE_SMTP_PASSWORD');
  if (!config.tmdb.readToken) off.push('whats_popular / title_details — set TMDB_READ_TOKEN');
  if (!config.jfago.password || !config.jfago.baseUrl) off.push('invite_to_jellyfin — set JFAGO_URL and JFAGO_PASSWORD');
  if (!config.audiobookshelf.apiKey || !config.audiobookshelf.baseUrl) off.push('invite_to_audiobookshelf — set ABS_URL and ABS_API_KEY');
  if (!config.runbookPath) off.push('read_runbook — set RUNBOOK_PATH');
  // One line per absent service, naming the variable that turns it back on.
  // A stranger's most common state is "most of these", so the list has to read
  // as a checklist rather than as a wall of failures.
  const svc: [keyof typeof config.services, string][] = [
    ['sonarr', 'Sonarr (TV: add/search/gaps/grab) — set SONARR_API_KEY'],
    ['radarr', 'Radarr (films: add_movie) — set RADARR_API_KEY'],
    ['prowlarr', 'Prowlarr (audiobook search, indexer_admin) — set PROWLARR_API_KEY'],
    ['jellyfin', 'Jellyfin (jellyfin_sessions) — set JELLYFIN_API_KEY'],
    ['qbittorrent', 'qBittorrent (stuck_downloads) — set QBITTORRENT_LAN_URL'],
    ['dispatcharr', 'Dispatcharr (channel_health, livetv_status) — set DISPATCHARR_URL'],
  ];
  for (const [key, line] of svc) if (!config.services[key]) off.push(line);
  if (off.length) {
    console.error(`[jedd] not configured, so NOT offered (${off.length}):`);
    for (const line of off) console.error(`[jedd]   - ${line}`);
  }
  if (config.kindle.smtpPassword && (!config.sabnzbd.baseUrl || !config.sabnzbd.apiKey)) {
    console.error(
      '[jedd] usenet ebooks off — set SABNZBD_URL and SABNZBD_API_KEY. Torrent and IRC ebook paths are unchanged.',
    );
  } else if (
    config.sabnzbd.baseUrl &&
    config.sabnzbd.apiKey &&
    (!config.sabnzbd.storagePrefix || !config.sabnzbd.localDir)
  ) {
    console.error(
      '[jedd] usenet ebooks off until SABNZBD_STORAGE_PREFIX and SABNZBD_LOCAL_DIR are set. Nothing will be queued.',
    );
  }

  const reg = await client.ensureWebhook(config.bluebubbles.publicUrl, ['new-message']);
  console.error(`[jedd] webhook ${reg.outcome}: ${config.bluebubbles.publicUrl}`);
  // ⚠️ Printed even when empty. A removal nobody logged is how the orphan
  // happened in the first place, with the sign reversed.
  console.error(
    reg.removed.length
      ? `[jedd] 🔴 REMOVED ${reg.removed.length} stale row(s) on our own port: ${reg.removed.map((r) => `#${r.id} ${r.url}`).join(', ')}`
      : '[jedd] removed 0 existing registrations (nobody else\'s row was touched).',
  );

  // 🔴 Deregister on the way out, and say whether it worked. A shutdown that
  // leaves the row behind means BlueBubbles keeps delivering to a closed port.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\n[jedd] ${signal} — deregistering ${config.bluebubbles.publicUrl}`);
    // 🔴 FIRST, and bounded. A pm2 restart lands mid-turn sooner or later, and
    // exiting with a "…" still showing leaves a real person watching a reply
    // that is never coming — for however long Apple keeps it up, which is not a
    // number this codebase knows. `stopAll` cannot hang shutdown.
    await presence.stopAll().catch(() => {});
    try {
      const rows = await client.listWebhooks();
      const ours = rows.filter((w) => w.url === config.bluebubbles.publicUrl);
      for (const w of ours) {
        const res = await client.deleteWebhook(w.id);
        console.error(`[jedd] deleted webhook #${w.id}: ${res.ok ? 'ok' : `FAILED http ${res.status}`}`);
      }
      if (ours.length === 0) console.error('[jedd] our row was already gone.');
    } catch (e) {
      // 🔴 Loud. An orphan left behind is the failure that hides for a version.
      console.error(
        `[jedd] 🔴 COULD NOT DEREGISTER: ${(e as Error).message}\n` +
          `[jedd] 🔴 DELETE ${config.bluebubbles.publicUrl} BY HAND before starting anything else.`,
      );
    }
    // Leave the channel properly rather than dropping the socket. We are a guest
    // there, and a client that vanishes without QUIT is the kind that gets
    // noticed by ops. Both SIGINT and SIGTERM reach here; pm2 sends SIGINT.
    try {
      irc?.stop();
    } catch {
      /* never let a courtesy step block shutdown */
    }
    await receiver.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const timer = setInterval(() => {
    // 🔴 The follow-up runner sends through the SAME gated connector, so a
    // rehearsal cannot leak a "here is how that download went" message to
    // somebody outside the send audience an hour after the window closed.
    void runDueFollowups(followups, {
      config,
      send: (to, text) => connector.send(to, text),
      // An `ebook-deliver` follow-up finishes the job the turn could not: it
      // needs the same address store and mail sender the tool used, and the IRC
      // client, because for IRC the REQUEST itself happens out here.
      kindle,
      mail: ebook.send,
      // 🔴 The leg that closes the loop: Amazon reports a refusal by EMAIL,
      // minutes after the send has already returned a clean 250, so the only
      // place that evidence exists is the sending account's mailbox. Absent
      // credentials leave `mailbox` undefined, and the check then reports
      // `blind` rather than silence — see `runKindleVerify`.
      ...(mailbox ? { mailbox } : {}),
      mounts: DEFAULT_MOUNTS,
      onlySendTo: ebook.onlySendTo,
      ...(irc ? { irc } : {}),
    });
  }, TICK_MS);
  timer.unref();

  let turns = 0;

  /**
   * ── 🔴 ONE TURN PER BURST. THIS IS THE DISPATCH, AND IT IS THE FIX. ────────
   *
   * `BlueBubblesReceiver` starts every webhook with a bare `void this.ingest(…)`
   * and turns here run 25–790 SECONDS, so texting twice used to mean two turns
   * running at once, each blind to the other and both mutating the one history
   * array `Agent` keeps per sender. Measured live 2026-08-27: `add_movie` ran
   * twice for one request, and on Jeff's thread the reply to his second message
   * landed ten seconds before the reply to his first.
   *
   * The queue serialises PER SENDER — Robin never waits behind Jeff — and merges
   * a burst into a single turn. The reasoning for joining rather than queueing
   * or superseding is in `turn-queue.ts`; the short version is that only joining
   * makes "every tool ran twice" structurally impossible, because a batch is one
   * tool loop and one reply.
   */
  const queue = new TurnQueue<IncomingMessage>({
    keyOf: (m) => m.senderHandle,
    settle: () => sleep(BURST_SETTLE_MS),
    run: async (batch, waited) => handleBurst(batch, waited),
    /**
     * 🔴 THE READ RECEIPT DOES NOT WAIT FOR THE SETTLE WINDOW.
     *
     * `connector.ts` promises the receipt goes out "as Jedd picks the message
     * up, not after it has thought about it", and marking read from inside the
     * turn would have made that false by five seconds for EVERY message — which
     * is precisely the silence the receipt exists to fill. So it is marked at
     * accept time, here.
     *
     * ⚠️ `withPresence` marks read AGAIN when the turn starts, and that is
     * deliberate rather than an oversight: `markChatRead` is idempotent and
     * fire-and-forget, the second call keeps the `presence=` token in the turn
     * line honest about what the TURN itself signalled, and one redundant call
     * is a fair price for not splitting a two-line seam across two files.
     */
    onAccepted: (m) => {
      connector.markRead(m.senderHandle);
    },
  });
  console.error(
    `[queue] one turn per burst: turns are serialised per sender and a burst settles for ` +
      `${BURST_SETTLE_MS}ms before it runs. Concurrent turns for one sender are no longer possible.`,
  );
  /**
   * 🔴 SAID AT BOOT BECAUSE THE ALTERNATIVE IS INFERRING IT FROM AN ABSENCE.
   *
   * A turn that runs long and says nothing is indistinguishable from a turn that
   * died — that is the whole defect this closes — and "is the notice even armed
   * on this build?" is the same question one level up. Stating the threshold
   * here means a log that shows no `notices=` token can be read as *no turn ran
   * that long*, rather than as *the feature may not be in this image*.
   */
  console.error(
    `[notice] a turn still running after ${stillWorkingMs}ms tells the sender so, and again on a ` +
      `doubling gap up to ${MAX_NOTICES} times. A turn that dies always sends a message; a timeout ` +
      'says it timed out.',
  );
  /**
   * 🔴 THE EFFECTIVE BUDGET, SAID OUT LOUD. `LLM_TURN_TIMEOUT_MS` falls back
   * silently on anything unparseable, so `LLM_TURN_TIMEOUT_MS=90O000` (letter O)
   * runs at the built-in 900s while looking configured. This is the line that
   * tells the difference, and it is the same argument the `[notice]` line above
   * makes for itself.
   */
  console.error(
    `[llm] one model call may run ${config.llm.turnTimeoutMs ?? TURN_TIMEOUT_MS}ms` +
      `${config.llm.turnTimeoutMs === undefined ? ' (built-in default; LLM_TURN_TIMEOUT_MS unset or unparseable)' : ' (from LLM_TURN_TIMEOUT_MS)'}` +
      `; a turn may make up to ${MAX_STEPS} of them.`,
  );

  /**
   * The whole batch answered by one turn.
   *
   * 🔴 THE TEXT IS JOINED AND THE LAST MESSAGE IS THE ONE ANSWERED. Both are
   * facts rather than choices: the person wrote these lines one after another,
   * which is how they read on the phone, and a reply to a burst belongs against
   * its final message the way a human's would.
   */
  const handleBurst = async (batch: IncomingMessage[], waited: BatchWait): Promise<void> => {
    const last = batch[batch.length - 1]!;
    /**
     * ⚠️ SPREAD, NOT REBUILT FIELD BY FIELD. A hand-listed copy type-checks
     * today because those are all the fields `IncomingMessage` has — and would
     * silently DROP any field added to it later, on the burst path only, with
     * nothing failing to compile.
     */
    const mergedRaw = mergeAttachmentsRaw(batch);
    const message: IncomingMessage = {
      ...last,
      /**
       * ⚠️ EMPTY TEXTS ARE FILTERED OUT, and that is new with images. A photo
       * sent without a caption arrives as `text: ""`, so an unfiltered join
       * turns "here" + photo into `"here\n"` — and a photo on its own into a
       * bare newline, which is not an empty string and therefore survives every
       * downstream emptiness check as though the person had typed something.
       */
      text: joinBurstText(batch),
      ...(mergedRaw ? { attachmentsRaw: mergedRaw } : {}),
      ...(last.sourceGuid ? {} : anchorFrom(batch)),
    };
    /**
     * ⚠️ A voice memo, a contact card or a GamePigeon move with no text is a
     * message Jedd was always silent about, and it must not start costing a
     * 25–790 second turn to say "I can only look at pictures". Decided from the
     * raw payload, so nothing has been downloaded at this point.
     */
    if (!worthAnswering(message.text, message.attachmentsRaw, imageLimits)) {
      console.error(
        `[jedd] skipped ${message.senderHandle}: an attachment-only message with nothing I can look at`,
      );
      return;
    }

    /**
     * 🔴 CAPTURED AT ENTRY, NOT READ AT LOG TIME.
     *
     * `turns` is shared across concurrent turns, and the completion line prints
     * at the END. Interpolating `${turns}` there reads whatever the counter has
     * reached by then, so an earlier-finishing turn prints a LATER turn's
     * number. Measured live 2026-08-27: two overlapping turns both logged
     * `turn 3` and no `turn 2` line existed at all —
     *
     *   turns=2  A enters 01:04:20
     *   turns=3  B enters 01:05:47   (A still running)
     *            A ends 01:07:54 -> printed "turn 3"   ← should be 2
     *            B ends 01:08:21 -> printed "turn 3"
     *
     * ⚠️ NOTHING WAS ACTUALLY DUPLICATED — two different questions, two
     * different answers, each handled once (verified by hashing `userText` in
     * audit.jsonl). But two identical `turn 3` lines read exactly like one
     * message answered twice, and it was reported and escalated as a live
     * double-reply defect. **A racy label on a correct system reads as a broken
     * system**, and costs more than the label is worth.
     */
    const turn = ++turns;
    const started = Date.now();
    /**
     * 🔴 THE ONLY THING THAT TELLS THIS PERSON THE TURN IS STILL ALIVE.
     *
     * Turns here run 25–790 seconds and the model call can be killed at 900s per
     * step. Measured live 2026-08-26: Jeff asked "Give me the other 14" twice,
     * twenty minutes apart, and got NOTHING either time — no reply, no error.
     * The reasoning, the threshold, and why the notice sends PLAIN rather than
     * anchored are all in `turn-notice.ts`.
     *
     * ⚠️ DECLARED OUTSIDE THE `try`, so the `catch` can disarm it too. Inside,
     * the catch could not see it — and the one path where a stray notice would
     * be most visible is the failure path, where the person has just been
     * apologised to.
     *
     * ⚠️ Armed and disarmed around `agent.handle` ONLY: inside the presence
     * region, outside the send. Disarming before `connector.send` is what makes
     * it structurally impossible to schedule a "still working" note after the
     * answer has been composed.
     */
    const notice = new StillWorkingNotice({
      notify: (text) => connector.send(message.senderHandle, text),
      afterMs: stillWorkingMs,
    });
    try {
      /**
       * 🔴 THE READ RECEIPT AND THE TYPING INDICATOR ARE ONE CALL — see
       * `withPresence`. The typing region covers the model turn AND the send, so
       * the "…" runs for exactly as long as Jedd owes this person a reply, and
       * it is transparent: it rethrows whatever `agent.handle` or `send` throws
       * into the catch below, stopping the indicator on the way past either way.
       *
       * ⚠️ 2026-08-26: THIS ORDERING WAS SUSPECTED OF CAUSING A FLICKER AND WAS
       * CLEARED. Jeff saw "…" reappear for a beat after every reply, which looks
       * exactly like a stop landing late — and it was not. The stop was landing
       * 4ms after the message and STARTING the indicator, because BlueBubbles'
       * `DELETE /chat/{guid}/typing` calls `startTyping` (see
       * `client.stopTyping`). Covering the send stays right: BlueBubbles clears
       * its own `typingCache` and stops typing INSIDE its send path before the
       * message is dispatched, which is tighter ordering than anything callable
       * from out here. Ending the region before the send would also mean AWAITING
       * a presence call on the reply path — the one rule `presence.ts` exists to
       * enforce. Do not swap these.
       */
      const signals: PresenceRecord = { signalled: [] };
      /**
       * ⚠️ DECLARED PER TURN, INSIDE the handler. Turns run concurrently, so a
       * shared one would be overwritten by whichever reply finished last and the
       * log line would describe the wrong send with total confidence.
       */
      const sent: SendRecord = { anchored: false, detail: 'no send reached' };
      const record = await withPresence(
        connector,
        message,
        async () => {
          /**
           * 🔴 THE CLOCK STARTS WHEN THEY TEXTED, NOT WHEN JEDD GOT ROUND TO
           * THEM. A message that arrived behind an in-flight turn has already
           * been waiting — up to a whole 790-second turn plus a settle — and
           * arming from here would understate that by exactly that much, on the
           * message MOST likely to feel ignored.
           */
          notice.arm(waited.queuedForMs);

          /**
           * 🔴 THE DOWNLOAD HAPPENS HERE, INSIDE THE TURN — not at ingest.
           *
           * By this line the read receipt has been sent, the typing indicator is
           * up, the burst has settled and `notice` is armed, so a slow transfer
           * looks like Jedd thinking rather than Jedd ignoring someone. It also
           * means the per-turn cap is applied to the WHOLE burst before a single
           * byte is fetched.
           *
           * ⚠️ It cannot throw: `createImageHydrator` turns every failure into a
           * `trouble` entry. The catch is for a bug in the hydrator itself, and
           * it ends the same way on purpose — a picture that will not download
           * must never swallow the sentence it was sent with.
           */
          let attachments;
          try {
            attachments = await hydrateAttachments(message.attachmentsRaw);
          } catch (e) {
            console.error(`[jedd] 🔴 attachment hydration threw: ${(e as Error).message}`);
            attachments = {
              images: [],
              trouble: [
                { reason: 'unfetchable' as const, name: 'the attachment', detail: (e as Error).message },
              ],
              overflow: 0,
            };
          }

          let r: TurnRecord;
          try {
            r = await agent.handle(message.senderHandle, message.text, attachments);
          } finally {
            notice.disarm();
          }
          /**
           * 🔴 `message.sourceGuid` NAMES THE MESSAGE THIS REPLY ANSWERS, AND IT
           * IS A FACT, NOT A CHOICE.
           *
           * ⚠️ AMENDED 2026-08-27. This used to read *"`agent.handle` is handed
           * exactly one message's text, so a turn is structurally incapable of
           * answering two"*. A turn is now handed a whole BURST, so it answers
           * every message in it on purpose — and the target is the LAST one,
           * which is where a person's own reply to a burst would go.
           *
           * That is not a weakening. Before the queue, a turn was handed one
           * message and answered a different one anyway, because a second turn
           * was pushing into the same history array while it ran. The trigger
           * and the subject were only ever believed to match; now the batch IS
           * the subject, and there is nothing else in flight to confuse it with.
           */
          await connector.send(message.senderHandle, r.replyText, message.sourceGuid, sent);
          return r;
        },
        signals,
      );
      /**
       * 🔴 `presence=` SAYS WHAT WAS ATTEMPTED, NOT WHAT ARRIVED.
       *
       * `Presence.report()` returns early on success, so a call that worked and
       * a call that was never made used to log identically — and when Jeff said
       * he got no read receipt, the log could not say which. This token settles
       * that half. It cannot settle delivery, because presence runs on a chain
       * nobody awaits and the outcome does not exist yet at this line; a failure
       * announces itself separately, once, on its own `[presence]` line. So
       * `presence=read+typing` with no `[presence]` line under it is a clean
       * turn, and `presence=none` means Jedd said nothing to this person on
       * purpose — an absent `Presence`, or a handle outside `JEDD_SEND_TO`.
       */
      console.error(
        `[jedd] turn ${turn} from ${message.senderHandle}: ` +
          /**
           * 🔴 `burst=` IS THE WITNESS THAT COALESCING HAPPENED ON THIS TURN.
           *
           * Absent it, a burst answered once and a burst that never coalesced
           * are the same line, and the only way to tell would be to count
           * inbound messages in BlueBubbles' database and pair them by hand —
           * which is exactly the archaeology that made this defect take two days
           * to see. Printed only when there was a burst; the ordinary
           * one-in-one-out turn does not need a token saying it was ordinary.
           */
          `${batch.length > 1 ? `burst=${batch.length} ` : ''}` +
          /**
           * 🔴 `notices=` SAYS WHAT WAS ATTEMPTED, NOT WHAT ARRIVED — the same
           * disclaimer `presence=` makes two lines above, and for the same
           * reason: the counter increments before the send resolves, and a
           * handle outside `JEDD_SEND_TO` is suppressed quietly. What it does
           * settle is the half that was unanswerable before it existed: a turn
           * that ran 300s and reassured the sender, and a turn that ran 300s in
           * silence because the timer was never armed, printed the IDENTICAL
           * line — and the second is the whole defect. A failed send announces
           * itself separately on its own `[notice]` line.
           */
          `${notice.noticesSent > 0 ? `notices=${notice.noticesSent} ` : ''}` +
          `${record.toolCalls.map((c) => c.name).join(',') || 'no tools'} ` +
          /**
           * 🔴 `denial=unlicensed` IS THE WITNESS THAT JEDD MAY HAVE JUST TOLD
           * SOMEBODY IT COULD NOT DO SOMETHING IT CAN — printed for the same
           * reason as `burst=` and `notices=` above.
           *
           * Without it, a turn where Jedd asserted a limit on its own tools that
           * nothing in the turn licensed prints the IDENTICAL line to one where
           * the question never arose, and the only way to tell is archaeology
           * over `audit.jsonl` — which is precisely what every other token here
           * exists to avoid. The sentence itself is in the turn record and
           * deliberately not here: it is a whole reply and this is one line.
           *
           * ⚠️ MOST OF THESE ARE HONEST. 25 of 35 capability denials measured
           * over the first 262 production turns were TRUE. This flags a turn as
           * WORTH CHECKING, not as a defect.
           *
           * 🔴🔴 AND `grep -c` OVER THIS TOKEN IS A FLOOR, NOT A TOTAL — it
           * under-counts by roughly FOUR. The detector is a phrase list: 74.3%
           * recall over 262 historical turns spread across many questions, but
           * **25% over eight live denials of a single question**. Report "at
           * least N", never "N".
           */
          `${record.unlicensedDenial ? 'denial=unlicensed ' : ''}` +
          /**
           * 🔴 `reply=` SAYS WHETHER THIS REPLY WAS QUOTED TO A SPECIFIC MESSAGE.
           *
           * It exists because the answer used to be built and thrown away:
           * `send()` returns void, so the `[anchored: …]` string never reached
           * this file and the only way to find out whether threading had fired
           * was to read BlueBubbles' own database. Measured 2026-08-26 —
           * `grep -c anchored jedd.log` returned 0 on a day threading demonstrably
           * worked twice.
           *
           * It is filled from inside the send gate and reports the OUTCOME, so a
           * reply that was meant to be anchored and got downgraded to plain reads
           * `reply=plain` — the downgrade reason is in the detail beside it.
           */
          `presence=${presenceToken(signals)} reply=${sendToken(sent)} ${Date.now() - started}ms`,
      );
      // Only when there is something to say: an anchored send, or a downgrade.
      // A plain reply on a quiet turn does not need a second line about itself.
      if (sent.anchored || sent.detail.includes('PLAIN after')) {
        console.error(`[jedd]   send: ${sent.detail}`);
      }
    } catch (e) {
      // A failing turn must not stop the next message arriving.
      console.error(`[jedd] turn ${turn} THREW: ${(e as Error).message}`);
      /**
       * ⚠️ BELT AND BRACES. `withPresence` rethrows, so `agent.handle`'s own
       * `finally` has already disarmed this on every path that reaches here —
       * but a future throw between the arm and that `try` would not have, and
       * the cost of being wrong is a "still working" note arriving four minutes
       * after the apology. Disarm is idempotent.
       */
      notice.disarm();
      /**
       * 🔴 SILENCE IS NEVER THE RIGHT ANSWER TO A MESSAGE.
       *
       * This catch used to log and nothing else. To the person who texted, a
       * thrown turn was INDISTINGUISHABLE from the bot being switched off,
       * ignoring them, or never receiving it — and the only evidence was a line
       * in a log they cannot read. The most likely cause is also the most
       * invisible: an unreachable model endpoint, which throws here on every
       * single turn while the process stays up and healthy forever.
       *
       * The reply is deliberately plain. It says something failed and that a
       * retry is worth trying; it does NOT carry the exception text, which can
       * name internal hosts and is meaningless to the reader anyway.
       *
       * ⚠️ It goes through `connector.send`, so `JEDD_SEND_TO` still applies —
       * a handle outside the audience is suppressed here exactly as it is on the
       * success path. This does not become a way to text someone we may not.
       *
       * ⚠️ And it is itself wrapped: if BlueBubbles is what failed, the apology
       * cannot be delivered either, and throwing from a catch block would take
       * out the handler that keeps the NEXT message working.
       */
      try {
        /**
         * 🔴 THE WORDING IS `failureReply`'s, NOT A LITERAL HERE, AND THAT IS
         * THE POINT OF THE CHANGE.
         *
         * A timeout used to be told as a generic "worth trying again in a
         * moment" — advice that is actively wrong for the failure that produced
         * it, because asking for the same 14-item list again spends another 900
         * seconds arriving at the same abort. `failureReply` names the timeout
         * and asks for a shorter question. It is a pure function in
         * `turn-notice.ts` precisely so a test can assert on the sentence: this
         * catch sits inside `main()`, which stands up BlueBubbles, Ollama, IRC,
         * IMAP and two SSH identities before it is reachable, so nothing here is
         * testable in place.
         */
        await connector.send(message.senderHandle, failureReply(e), message.sourceGuid);
      } catch (sendErr) {
        console.error(`[jedd] turn ${turn} could not even report the failure: ${(sendErr as Error).message}`);
      }
    } finally {
      /**
       * 🔴 ONE REPLY ANSWERED ALL OF THEM, SO CLOSE ALL OF THEM — ON EVERY PATH.
       *
       * `sendReporting` closes only the message it was handed. The earlier ones
       * in the batch were answered by that same reply and would otherwise sit in
       * the burst until `BURST_TTL_MS` (20 minutes), quote-anchoring every reply
       * this person got in the meantime.
       *
       * ⚠️ IN A `finally`, NOT AFTER THE SEND. On the success path either place
       * works. On the FAILURE path — the model throws, or the send throws — only
       * this one runs, and that is the path most likely to hit it: the apology
       * sent from the catch above closes `message.sourceGuid` and nothing else,
       * so every earlier message of a failed burst would be left open. Which is
       * verbatim the leak this block exists to prevent, armed on exactly the
       * case nobody tests.
       *
       * ⚠️ Inert while `REPLY_THREADING_ENABLED` is false — `threading` is
       * `undefined` then. Written now because the alternative is a landmine that
       * arms itself the day somebody flips that flag.
       */
      for (const earlier of batch.slice(0, -1)) {
        threading?.answered(earlier.senderHandle, earlier.sourceGuid);
      }
    }
  };

  /**
   * 🔴 EVERY INBOUND MESSAGE GOES THROUGH THE QUEUE, INCLUDING REPLAY.
   *
   * `submit` resolves when the batch containing the message has been handled, so
   * `replayMissed` — which awaits each ingest in turn — stays exactly as serial
   * as it was. And it never rejects: BlueBubbles dispatches fire-and-forget and
   * there is nowhere above here to put an error.
   */
  await connector.listen((message) => queue.submit(message));
}

main().catch((e) => {
  console.error(`[jedd] FATAL: ${(e as Error).message}`);
  process.exit(1);
});
