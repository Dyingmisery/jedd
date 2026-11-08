import { createServer, type Server } from 'node:http';
import type { Connector, IncomingMessage, SendRecord } from '../connector.js';
import { BlueBubblesClient } from './client.js';
import { classifyPayload, type InboundVerdict } from './payload.js';
import type { Presence } from './presence.js';
import type { SeenStore } from './seen.js';
import { ReplyThreading } from './threading.js';

export interface ReceiverOptions {
  client: BlueBubblesClient;
  seen: SeenStore;
  /**
   * 🔴 OUR OWN iMESSAGE ADDRESS. REQUIRED, AND NOT OPTIONAL ON PURPOSE.
   *
   * A message from this address is an infinite self-reply loop that every other
   * inbound guard passes — see the SELF-ADDRESSED block in `classifyPayload`.
   * An optional field would make the loop the thing you get by FORGETTING, and
   * this codebase's rule is that the dangerous value has to be typed out.
   *
   * It comes from `assertIdentity()` (`detected_imessage`, read off the server
   * at boot), never from a constant: the point is to compare against the account
   * the bridge is actually signed in as.
   */
  selfIdentity: string;
  host: string;
  /** 0 asks the OS for an ephemeral port; `start()` returns the real one. */
  port: number;
  path: string;
  /**
   * Every payload the loop does NOT get, with the reason.
   *
   * This is how the shadow recorder is nearly free: V1's own replies arrive on
   * this same webhook as outbound echoes, so the rows the loop must never see
   * are exactly the rows the parity corpus is built from. Classification returns
   * a verdict rather than a boolean for this reason.
   */
  onSkipped?: (verdict: InboundVerdict) => void;
  /**
   * Told about every message the loop is about to answer, so the send path can
   * later ask whether this person had more than one reply outstanding.
   *
   * ⚠️ It is recorded HERE, at the one point every inbound message passes
   * through — live webhook and replay both — rather than in the agent loop.
   * There are two entry points that run turns and only one that ingests, and a
   * burst counted in only one of them is a rule that is silently wrong half
   * the time.
   */
  threading?: ReplyThreading;
  log?: (line: string) => void;
}

export interface ReplayOutcome {
  delivered: number;
  saturated: boolean;
  detail: string;
}

type Handler = (message: IncomingMessage) => Promise<void>;

/**
 * Receives from BlueBubbles. Knows nothing about sending — that capability
 * lives on the connector wrapper, so a shadow deployment can hold a receiver
 * without holding anything able to speak.
 */
export class BlueBubblesReceiver {
  private server?: Server;

  private handler?: Handler;

  private readonly log: (line: string) => void;

  constructor(private readonly opts: ReceiverOptions) {
    this.log = opts.log ?? ((l) => console.error(l));
  }

  /** Start listening. Resolves with the bound port. */
  async start(handler: Handler): Promise<number> {
    this.handler = handler;
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith(this.opts.path)) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        /**
         * 🔴 ANSWER FIRST, WORK SECOND.
         *
         * BlueBubbles dispatches to its webhooks fire-and-forget (its own source
         * says `// We don't need to await this`), so a slow subscriber cannot
         * delay another one. That is a reason not to worry, NOT a licence to be
         * slow: nothing here should ever hold a connection open while a model
         * turn runs.
         */
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

        let payload: unknown = null;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          payload = null;
        }
        void this.ingest(payload, 'live');
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        const addr = this.server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.log(`[bb] listening on http://${this.opts.host}:${port}${this.opts.path}`);
        resolve(port);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * One payload, from either the live webhook or replay.
   *
   * Both paths go through here on purpose: dedup that only covers one of them
   * re-delivers on every restart, and the watermark advances from both so a
   * quiet period of our own sends does not leave it stale.
   */
  private async ingest(payload: unknown, source: 'live' | 'replay', handler?: Handler): Promise<void> {
    const verdict = classifyPayload(payload, this.opts.selfIdentity);

    // The watermark tracks what we have SEEN, not what we delivered — an
    // outbound echo or a tapback still means that rowid is accounted for.
    if (verdict.rowid !== null) {
      try {
        this.opts.seen.advanceWatermark(verdict.rowid);
      } catch (e) {
        // A rowid we refuse to store is loud. V1's silently-inert watermark is
        // exactly what this must never become.
        this.log(`[bb] 🔴 REFUSED to advance watermark: ${(e as Error).message}`);
      }
    }

    if (verdict.action === 'skip') {
      this.opts.onSkipped?.(verdict);
      return;
    }

    if (!this.opts.seen.firstSight(verdict.dedupKey)) {
      this.log(`[bb] duplicate ${verdict.dedupKey} (${source}) — BlueBubbles double-fires; ignored`);
      return;
    }

    // Before the turn, not after: the second message of a burst usually arrives
    // WHILE the first turn is still running, and the whole point is that the
    // first reply can see it.
    this.opts.threading?.arrived(verdict.message.senderHandle, verdict.message.sourceGuid ?? null);

    const run = handler ?? this.handler;
    if (!run) return;

    try {
      await run(verdict.message);
    } catch (e) {
      // A failing turn must not take the listener down or stop the next message.
      this.log(`[bb] handler threw on ${verdict.dedupKey}: ${(e as Error).message}`);
    }
  }

  /**
   * Deliver everything missed while we were down.
   *
   * 🔴 V1's equivalent is INERT: its watermark holds a microsecond timestamp
   * (`1783501783569848`) against rowids of ~2601, so `rowid > watermark` is
   * always false and it recovers nothing — while printing
   * `"Replay: no messages after rowid …"`, **the same line a healthy quiet
   * restart prints**. The failure state and the all-clear are one string.
   *
   * So this returns an outcome the caller must look at, and an incomplete
   * replay says so.
   */
  async replayMissed(handler?: Handler): Promise<ReplayOutcome> {
    const since = this.opts.seen.watermark();

    /**
     * 🔴 A FIRST BOOT HAS NO DOWNTIME TO RECOVER FROM, AND MUST NOT REPLAY.
     *
     * A virgin `SeenStore` has watermark 0. Replaying from 0 walks back up to
     * `MAX_REPLAY_PAGES` × 50 messages and hands every inbound one to the agent
     * as if it had just arrived — so the very first start of the live entry
     * point would answer a backlog of weeks-old messages, to the whole
     * household, in a burst. It would look exactly like a normal startup.
     *
     * Replay exists to cover the gap between "was running" and "is running
     * again". If there has never been a run, there is no gap: seed the watermark
     * to the newest rowid and start from now.
     *
     * ⚠️ A server we cannot read gives `null`, and `null` is NOT 0. Seeding
     * fails closed — no replay at all — because guessing 0 is the flood.
     */
    if (since === 0) {
      const newest = await this.opts.client.newestRowid();
      if (newest !== null) {
        this.opts.seen.advanceWatermark(newest);
        const detail =
          `first boot: no watermark stored, so there is no downtime to recover. Seeded at rowid ` +
          `${newest} and starting from now rather than replying to history.`;
        this.log(`[bb] ${detail}`);
        return { delivered: 0, saturated: false, detail };
      }
      const detail =
        '🔴 first boot AND the newest rowid could not be read, so the watermark is unseeded. ' +
        'Skipping replay entirely — replaying from 0 would answer a backlog of old messages.';
      this.log(`[bb] ${detail}`);
      return { delivered: 0, saturated: false, detail };
    }

    const res = await this.opts.client.replaySince(since);
    for (const row of res.messages) {
      await this.ingest({ type: 'new-message', data: row }, 'replay', handler);
    }
    const delivered = res.messages.length;
    const detail = res.saturated
      ? `🔴 REPLAY INCOMPLETE: walked ${res.pages} pages from rowid ${since} without reaching the ` +
        `watermark, so messages older than the ${delivered} recovered are LOST. This is reported ` +
        'rather than hidden — do not read it as "nothing was missed".'
      : delivered === 0
        ? `replay complete from rowid ${since}: nothing was missed`
        : `replay complete from rowid ${since}: ${delivered} message(s) recovered`;
    this.log(`[bb] ${detail}`);
    return { delivered, saturated: res.saturated, detail };
  }
}

/**
 * The full connector: receives and sends.
 */
/**
 * 🔴 WHO THIS CONNECTOR MAY TEXT, STATED OUT LOUD OR NOT AT ALL.
 *
 * `'everyone'` is the production cutover value. An array is the rehearsal value:
 * V2 receives the whole household's traffic — which is the point, that is what
 * exercises the receive path on real messages — but only *answers* the handles
 * named here. Everyone else gets silence for the length of the window, and
 * silence from a bot is recoverable in a way a wrong answer to twelve people is
 * not.
 *
 * There is no default. An author who has not thought about it cannot get the
 * permissive value by forgetting, which is the same rule `registerable()`
 * applies to `writes` and `send_ebook` applies to `onlySendTo`. The literal
 * string has to be typed.
 */
export type SendAudience = 'everyone' | string[];

/**
 * Read the send audience from a raw environment value. Never defaulted.
 *
 * 🔴 The failure this prevents is not hypothetical: the rehearsal and the
 * cutover run the same binary against the same server, and the only thing
 * distinguishing "answer Jeff" from "answer twelve people" is this value. An
 * unset variable that meant `everyone` would make the dangerous case the one you
 * get by forgetting — so an unset variable is a refusal instead.
 */
export function parseSendAudience(raw: string | undefined): SendAudience {
  if (!raw || !raw.trim()) {
    throw new Error(
      'JEDD_SEND_TO is not set, so I do not know who I am allowed to text and I will not guess. ' +
        'Set it to "everyone" for a real cutover, or to a comma-separated list of handles ' +
        '(e.g. JEDD_SEND_TO="+15551234567") for an attended rehearsal, where everyone else gets ' +
        'silence rather than an untested answer.',
    );
  }
  const value = raw.trim();
  if (value === 'everyone') return 'everyone';
  const handles = value
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (handles.length === 0) {
    throw new Error(`JEDD_SEND_TO="${raw}" parsed to an empty list. Refusing to start on an ambiguous value.`);
  }
  return handles;
}

/** What a send actually did. See `BlueBubblesConnector.sendReporting`. */
export interface SendOutcome {
  state: 'suppressed' | 'accepted' | 'failed';
  /** 🔴 `null` means no verdict yet. It is NEVER a synonym for `false`. */
  delivered: boolean | null;
  detail: string;
  /**
   * The message this reply was QUOTED to, or `null` for an ordinary send.
   *
   * ⚠️ A FIELD, NOT A SUBSTRING OF `detail`. The first version of this read
   * `detail.includes('[anchored:')`, which is the same re-derivation this file
   * warns about everywhere else: the fact would live in two places, and a
   * reworded sentence would silently flip the log to the wrong answer with
   * nothing failing. The decision is made once, above, and carried.
   *
   * 🔴 Set on the DOWNGRADE paths too, and set to `null` there — a reply that
   * was meant to be anchored and went out plain is a plain reply, and reporting
   * the intention rather than the outcome is how a log starts lying.
   */
  anchoredTo: string | null;
}

export class BlueBubblesConnector implements Connector {
  readonly name = 'bluebubbles';

  constructor(
    private readonly receiver: BlueBubblesReceiver,
    private readonly client: BlueBubblesClient,
    /** Required. See `SendAudience` — there is deliberately no default. */
    private readonly audience: SendAudience,
    /** Told about every suppressed reply, so a rehearsal can see what it did not say. */
    private readonly onSuppressed?: (toHandle: string, text: string) => void,
    /**
     * Typing indicators and read receipts. **Optional by construction** — a
     * connector built without one has no way to signal presence at all, which is
     * the same argument `ShadowConnector` makes about sending. `undefined` is
     * not a disabled feature; it is an absent capability.
     */
    private readonly presence?: Presence,
    /**
     * The burst tracker. Optional for the same reason `presence` is: a connector
     * built without one cannot anchor replies at all, and every reply sends
     * plain — which is the old behaviour, not a broken one.
     *
     * 🔴 It must be the SAME instance the receiver was given. Two trackers would
     * each see half the picture and neither would ever count a burst.
     */
    private readonly threading?: ReplyThreading,
  ) {}

  /** Is this handle allowed to receive a reply? Exact match; no normalisation, no prefixes. */
  private allowed(toHandle: string): boolean {
    return this.audience === 'everyone' || this.audience.includes(toHandle);
  }

  /**
   * Send, and REPORT what happened rather than throwing it away.
   *
   * ── 🔴 A SUPPRESSED SEND IS A FAILED SEND, TO ANY CALLER THAT OWNS A ────────
   * ── CREDENTIAL ─────────────────────────────────────────────────────────────
   *
   * `send()` below can afford to return quietly on a suppression: a reply that
   * was not sent costs a reply. `invite_to_jellyfin` cannot, because by the time
   * it calls this **a live single-use Jellyfin invite already exists** — the link
   * IS the message, so the credential must be minted before the risky operation.
   * If a suppression came back looking like a success, the invite would stay live
   * for 24 hours for a message that nobody ever received. That is V1's exact
   * defect, reintroduced by the rehearsal gate rather than by the tool.
   *
   * So the three outcomes stay distinct all the way up:
   *
   *   `suppressed` → `delivered: false`  — did not go out. Revoke.
   *   `failed`     → `delivered: false`  — went out and was refused. Revoke.
   *   `accepted`   → `delivered: null`   — 🔴 **NO VERDICT YET, NOT SUCCESS.**
   *
   * `null` is never `false`. iMessage acquires delivery on ACK, so treating the
   * first few hundred milliseconds as failure would revoke every working invite.
   */
  async sendReporting(toHandle: string, text: string, inReplyTo?: string): Promise<SendOutcome> {
    // 🔴 The gate is HERE, above the transport, not in the agent and not in the
    // prompt. A suppressed reply must be unable to reach `sendText` even if
    // every layer above it decided to answer.
    if (!this.allowed(toHandle)) {
      this.onSuppressed?.(toHandle, text);
      return {
        state: 'suppressed',
        delivered: false,
        detail: `SUPPRESSED — ${toHandle} is outside the send audience, so nothing was sent.`,
        anchoredTo: null,
      };
    }

    /**
     * ── SHOULD THIS REPLY QUOTE THE MESSAGE IT IS ANSWERING? ─────────────────
     *
     * The decision is `ReplyThreading`'s and the reasoning lives there. The only
     * thing decided here is what happens when the anchored send FAILS, and that
     * is the part with teeth — see below.
     */
    const decision = this.threading?.decide(toHandle, inReplyTo) ?? {
      replyTo: null,
      burstSize: 0,
      detail: 'no threading tracker on this connector, so every reply sends plain',
    };

    try {
      const r = await this.client.sendText(toHandle, text, decision.replyTo);
      if (r.accepted) {
        this.threading?.answered(toHandle, inReplyTo);
        return {
          state: 'accepted',
          delivered: null,
          detail: decision.replyTo ? `${r.detail} [anchored: ${decision.detail}]` : r.detail,
          anchoredTo: decision.replyTo,
        };
      }
      if (!decision.replyTo) {
        this.threading?.answered(toHandle, inReplyTo);
        return { state: 'failed', delivered: false, detail: r.detail, anchoredTo: null };
      }
      return this.retryPlain(toHandle, text, inReplyTo, r.detail);
    } catch (e) {
      /**
       * 🔴 A THROW FROM AN ANCHORED SEND IS NOT THE SAME EVENT AS A THROW FROM
       * A PLAIN ONE, AND IT MUST NOT COST JEFF THE REPLY.
       *
       * Anchoring silently reroutes the send through BlueBubbles' Private API
       * (its validator forces `method = "private-api"` the moment
       * `selectedMessageGuid` is present), so an anchored send can fail for
       * reasons a plain send would not have: the helper bundle disconnecting —
       * it was dead as recently as 2026-08-24 — or a reply target the server
       * cannot resolve, which stalls 120s and then 500s.
       *
       * Threading is COSMETIC. Losing a reply is not. So a failure here is
       * downgraded to a plain send rather than propagated, and the downgrade is
       * announced.
       */
      if (!decision.replyTo) {
        this.threading?.answered(toHandle, inReplyTo);
        throw e;
      }
      return this.retryPlain(toHandle, text, inReplyTo, `threw: ${(e as Error).message}`);
    }
  }

  /**
   * The anchored send failed. Send it plain instead — but ONLY after checking
   * that the first one did not actually land.
   *
   * 🔴 THE READ-BACK IS THE POINT OF THIS FUNCTION, NOT THE RETRY.
   *
   * The failure that was actually measured (`Transaction timeout` on an
   * unresolvable reply target) writes nothing, so retrying after it is safe. But
   * a failure we did not measure — our own abort firing while the server was
   * mid-send, a socket dropped after the message went out — would put the SAME
   * TEXT on a real person's phone twice, and the second copy is not recallable.
   *
   * So `recentlySent` is asked first, and its three states are respected:
   * `true` means do not resend, `false` means it is safe, and `null` means WE DO
   * NOT KNOW — which is treated as "do not resend", because an unreadable
   * history is exactly the situation in which a duplicate would be invisible to
   * us and obvious to Jeff.
   */
  private async retryPlain(
    toHandle: string,
    text: string,
    inReplyTo: string | undefined,
    why: string,
  ): Promise<SendOutcome> {
    this.threading?.answered(toHandle, inReplyTo);
    const already = await this.client.recentlySent(toHandle, text);

    /**
     * 🔴 "THE SEND REPORTED FAILURE" AND "THE PERSON DID NOT GET IT" ARE
     * DIFFERENT FACTS, AND THIS IS THE ONE PLACE THEY COME APART.
     *
     * `already === true` means BlueBubbles' own history already holds this text:
     * the message LANDED and all we lost was the answer to our request. Calling
     * that `failed` would make `send()` throw, and the turn would be logged as
     * having thrown while Jeff sat there reading the reply. So it reports
     * `accepted` — which is what actually happened — with `delivered: null`,
     * because an entry in the sent history is still not a delivery receipt.
     */
    if (already === true) {
      return {
        state: 'accepted',
        delivered: null,
        detail:
          `the anchored (reply-quoted) send reported failure — ${why} — but the text is ALREADY IN the sent ` +
          'history, so it went out and only the reply-quote is in doubt. NOT re-sent.',
        // 🔴 `null`: we do not know whether the copy in the history carries the
        // quote, so claiming it was anchored would be a guess in the log.
        anchoredTo: null,
      };
    }
    if (already === null) {
      return {
        state: 'failed',
        delivered: null,
        detail:
          `🔴 the anchored (reply-quoted) send failed — ${why} — and it is UNKNOWN whether it went out ` +
          '(BlueBubbles\' history was unreadable), so it was NOT re-sent. `null` is not `false`: an ' +
          'unreadable history is exactly when a duplicate would be invisible to us and obvious to the ' +
          'person holding the phone.',
        anchoredTo: null,
      };
    }
    const plain = await this.client.sendText(toHandle, text);
    return plain.accepted
      ? {
          state: 'accepted',
          delivered: null,
          detail: `sent PLAIN after the anchored send failed (${why}) — the reply is intact, only the reply-quote was lost. ${plain.detail}`,
          anchoredTo: null,
        }
      : {
          state: 'failed',
          delivered: false,
          detail: `anchored send failed (${why}) AND the plain retry failed: ${plain.detail}`,
          anchoredTo: null,
        };
  }

  /**
   * Fire-and-forget send, for replies.
   *
   * ⚠️ Delegates to `sendReporting` rather than reimplementing the gate. Two send
   * paths would be two places for the audience check to drift, and the drift
   * would be invisible: each path is individually plausible.
   */
  /**
   * Poster for a numbered choice. Same audience gate as a text. A refusal or a
   * transport failure returns false and does not change the request.
   */
  async sendImage(toHandle: string, filename: string, bytes: Buffer): Promise<boolean> {
    if (!this.allowed(toHandle)) return false;
    const r = await this.client.sendAttachment(toHandle, filename, bytes);
    return r.accepted;
  }

  async send(toHandle: string, text: string, inReplyTo?: string, record?: SendRecord): Promise<void> {
    const r = await this.sendReporting(toHandle, text, inReplyTo);
    /**
     * 🔴 FILLED BEFORE THE THROW, NOT AFTER.
     *
     * A failed send is exactly when the caller most needs to know whether it was
     * anchored — an anchored send routes through a different BlueBubbles path
     * than a plain one, so "which kind of send failed" is half the diagnosis.
     * Recording it only on the success path would lose it precisely when it
     * matters.
     */
    if (record) {
      record.anchored = r.anchoredTo !== null;
      record.detail = r.detail;
    }
    if (r.state === 'failed') throw new Error(`send failed: ${r.detail}`);
  }

  /**
   * 🔴 THE LOOK-BACK THAT KEEPS A FALSE APOLOGY FROM FOLLOWING A DELIVERED REPLY.
   *
   * Delegates to `recentlySent` rather than re-reading the history: there is one
   * place that knows how to ask BlueBubbles "did this text go out" — the same
   * read-back `retryPlain` uses to decide whether a retry would double-text —
   * and a second implementation here would be a second answer that can drift
   * from it.
   *
   * 🔴 `null` passes through as `null`, NOT `false`. The caller sends the notice
   * on `null` on purpose (see `verifyDelivery` on the `Connector` interface):
   * an unreadable history is exactly when a swallowed turn is least visible.
   *
   * 🔴 NO AUDIENCE GATE ON PURPOSE. This reads BlueBubbles' own history, it
   * sends nothing, and a read is not a signal the other person sees — unlike
   * `markRead` and `withTyping`, there is nothing here to suppress.
   */
  async verifyDelivery(toHandle: string, text: string, withinMs?: number): Promise<boolean | null> {
    return this.client.recentlySent(toHandle, text, withinMs);
  }

  /**
   * ── 🔴 PRESENCE GOES THROUGH THE SAME AUDIENCE GATE AS A SEND ──────────────
   *
   * A read receipt and a typing indicator are both **visible to the other
   * person**. During a rehearsal, `JEDD_SEND_TO` promises everyone outside the
   * list SILENCE — and "Read 9:14 PM" followed by a typing bubble and then
   * nothing at all is not silence. It is worse than a wrong answer in one
   * specific way: it is unambiguous evidence that something read the message and
   * chose not to reply, and the person cannot tell whether that something was
   * Jeff.
   *
   * The gate lives here, above the transport, for the same reason `send` does:
   * one place, not re-derived per signal. `withTyping` still runs `fn` for a
   * suppressed handle — the turn is not the thing being suppressed, only the
   * announcement of it.
   */
  markRead(toHandle: string): boolean {
    if (!this.presence || !this.allowed(toHandle)) return false;
    this.presence.markRead(toHandle);
    return true;
  }

  async withTyping<T>(toHandle: string, fn: () => Promise<T>, onTyping?: () => void): Promise<T> {
    if (!this.presence || !this.allowed(toHandle)) return fn();
    onTyping?.();
    return this.presence.withTyping(toHandle, fn);
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    await this.receiver.start(handler);
    await this.receiver.replayMissed();
  }
}

/**
 * 🔴 SHADOW MODE: THE SEND PATH IS ABSENT BY CONSTRUCTION.
 *
 * Not a flag, not a config value, not a readOnly check — **this object holds no
 * client and therefore has nothing to send with.** A flag is a thing someone can
 * flip, or forget to set, or set in the wrong environment. There is nothing here
 * to flip.
 */
export class ShadowConnector implements Connector {
  readonly name = 'bluebubbles-shadow';

  constructor(private readonly receiver: BlueBubblesReceiver) {}

  async send(toHandle: string, text: string, _inReplyTo?: string, _record?: SendRecord): Promise<void> {
    throw new Error(
      `shadow mode: this connector cannot send (refused ${text.length} chars to ${toHandle}). It ` +
        'holds no BlueBubbles client, so this is not a disabled feature — there is no send path ' +
        'to enable.',
    );
  }

  /**
   * 🔴 A SHADOW IS INVISIBLE, AND A READ RECEIPT IS VISIBLE.
   *
   * The whole premise of shadow mode is that V1 keeps serving the household
   * while V2 watches — nobody is supposed to be able to tell V2 exists. A read
   * receipt or a typing bubble would be the *only* outward sign of it, and it
   * would appear on real people's phones alongside V1's real replies, looking
   * like V1 behaving strangely.
   *
   * Absent for the same structural reason `send` is: this object holds no
   * client and no `Presence`, so there is nothing here to enable. Unlike `send`
   * these do not throw — a shadow turn is *expected* to reach them, and a throw
   * would turn a correct no-op into a logged fault every message.
   */
  markRead(_toHandle: string): boolean {
    return false;
  }

  async withTyping<T>(_toHandle: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async listen(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    await this.receiver.start(handler);
    await this.receiver.replayMissed();
  }
}
