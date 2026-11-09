import type { Config } from './config.js';
import { ArrClient } from './media/arr.js';
import { availabilityLine, type PlexChecker } from './media/plex.js';
import { bookEmailed, bookFailureLine, bookStoppedWaiting, deliverEbook } from './media/ebook-deliver.js';
import {
  ebookAttemptCeiling,
  MAX_ATTEMPTS,
  type FollowupKind,
  type FollowupStore,
  type Followup,
} from './followups.js';
import type { IrcEbooks } from './media/irc-ebooks.js';
import type { MailSender } from './media/kindle-send.js';
import type { MailboxReader } from './kindle-mailbox.js';
import { verifyKindleDelivery } from './kindle-verify.js';
import type { MountMap } from './media/grab.js';
import type { FetchImpl } from './media/sabnzbd.js';
import type { KindleRegistry } from './kindle.js';
import { jellyfinGet, type JellyfinResponse } from './jellyfin.js';
import type { ExecImpl } from './hp.js';
import { roleFor } from './permissions.js';
import { parseSessions } from './safety.js';
import {
  SHED_DOWN_BYTES_PER_SEC,
  SHED_UP_BYTES_PER_SEC,
  observeContention,
  readThrottleState,
  restoreQbitSpeed,
} from './tools/qbit.js';
import type { ToolContext } from './tools/types.js';

/**
 * What happens when a follow-up comes due.
 *
 * 🔴 EVERY BRANCH HERE ANSWERS THE SAME THREE QUESTIONS BEFORE IT SPEAKS: why
 * did I wake, who am I talking to, and what did I actually observe. A follow-up
 * that cannot answer all three does not send — it defers, and when it runs out
 * of deferrals it says plainly that it could not finish.
 *
 * The failure mode being designed against is not "the message was wrong". It is
 * an unprompted message from a machine that cannot account for itself, which a
 * person cannot act on and learns to ignore.
 */

/** How long to wait before re-checking whether a shed can be lifted. */
export const RESTORE_CHECK_DELAY_MS = 30 * 60 * 1000;
/** How long to wait after an inconclusive check before trying again. */
export const RETRY_DELAY_MS = 15 * 60 * 1000;
/** How long between checks on a media add. Downloads take hours, not minutes. */
export const MEDIA_RECHECK_MS = 60 * 60 * 1000;
/**
 * Fallback only. The live gap is `config.ebookRecheckMs` (default 30s). The
 * attempt ceiling grows with that gap so the wait stays about 40 minutes.
 * Media, throttle, and Kindle-verify follow-ups do not use it.
 */
/**
 * How long between attempts when the delivery check cannot prove it can see.
 * Blindness is usually transient (a network blip, an IMAP hiccup), so this
 * retries a few times before it gives up — and when it gives up it SAYS so.
 */
export const VERIFY_RETRY_MS = 5 * 60 * 1000;
/**
 * How long after the first clean look to take one more.
 *
 * ~45 minutes after the send in total. Amazon's observed notices arrive within
 * minutes, but "observed" is a handful of samples and says nothing about the
 * tail — and the cost of being wrong is the silence this feature exists to end.
 */
export const LATE_RECHECK_MS = 33 * 60 * 1000;

export interface FollowupDeps {
  config: Config;
  send: (to: string, text: string) => Promise<void>;
  /** Needed to finish an `ebook-deliver`. Absent means it fails honestly. */
  kindle?: KindleRegistry;
  mail?: MailSender;
  irc?: IrcEbooks;
  mounts?: MountMap[];
  /** Test seam for SABnzbd. Unset in production. */
  sabFetch?: FetchImpl;
  /** Same live-test restriction the tool carries; see `DeliverDeps`. */
  onlySendTo?: string;
  exec?: ExecImpl;
  /**
   * Reads Amazon's refusal notices. Absent means the delivery check is not
   * deployed — which is reported as `blind`, never as "nothing went wrong".
   */
  mailbox?: MailboxReader;
  sleep?: (ms: number) => Promise<void>;
  jellyfin?: (config: Config, path: string) => Promise<JellyfinResponse>;
  now?: () => Date;
  /** Absent means Plex is not configured. Never treated as "available". */
  plex?: PlexChecker;
}

export interface FollowupOutcome {
  id: string;
  action:
    | 'restored'
    | 'held'
    | 'deferred'
    | 'abandoned'
    | 'nothing-to-do'
    | 'not-delivered'
    /** Amazon refused the book and the person has been told which code and why. */
    | 'refusal-reported'
    /** Checked, no refusal found. NOT a delivery confirmation. */
    | 'no-failure-seen'
    /** The check could not prove it can see failures, so it said nothing. */
    | 'blind';
  sent: boolean;
  detail: string;
}

/**
 * 🔴 ONE RUN AT A TIME. A SECOND TICK MUST NOT ENTER.
 *
 * The tick is every 60s and `void`-called, so nothing awaits the previous run.
 * An `ebook-deliver` can occupy a run for up to the IRC offer timeout — MINUTES
 * — and it only marks the record deferred or resolved AFTER that await. Until
 * then the record is still `pending` with a `dueAt` in the past, so every
 * intervening tick picked it up again: the same book requested from the bot
 * repeatedly, and **the same book emailed to the Kindle more than once.**
 *
 * A duplicate email is the one outcome on this path that cannot be taken back,
 * which is why this is a hard gate rather than a nicety.
 */
let running = false;

/**
 * Run every follow-up that is due. Never throws — a bad one must not stop the rest.
 *
 * `kind` limits the pass to one kind. The ebook timer uses it so a faster ebook
 * poll does not also wake media or throttle jobs.
 */
export async function runDueFollowups(
  store: FollowupStore,
  deps: FollowupDeps,
  opts?: { kind?: FollowupKind },
): Promise<FollowupOutcome[]> {
  if (running) return [];
  running = true;
  try {
    return await runDueFollowupsInner(store, deps, opts?.kind);
  } finally {
    running = false;
  }
}

/** Exposed only so a test can prove the overlap guard is what stops a second run. */
export function isFollowupRunInProgress(): boolean {
  return running;
}

async function runDueFollowupsInner(
  store: FollowupStore,
  deps: FollowupDeps,
  kind?: FollowupKind,
): Promise<FollowupOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const outcomes: FollowupOutcome[] = [];
  const due = store.due(now).filter((followup) => !kind || followup.kind === kind);
  for (const followup of due) {
    try {
      outcomes.push(await runOne(followup, store, deps, now));
    } catch (e) {
      store.resolve(followup.id, 'abandoned', `threw: ${(e as Error).message}`, now);
      outcomes.push({
        id: followup.id,
        action: 'abandoned',
        sent: false,
        detail: `threw: ${(e as Error).message}`,
      });
    }
  }
  return outcomes;
}

async function runOne(
  followup: Followup,
  store: FollowupStore,
  deps: FollowupDeps,
  now: Date,
): Promise<FollowupOutcome> {
  const ctx: ToolContext = {
    role: 'owner',
    senderHandle: followup.senderHandle,
    config: deps.config,
    exec: deps.exec,
    sleep: deps.sleep,
  };

  /**
   * 🔴 The recipient's authorisation is re-derived NOW, not trusted from the
   * stored record.
   *
   * The record was written by a different process, possibly days ago, and
   * `OWNER_HANDLE` may have changed since. A stored "this person is the owner"
   * would be an identity assertion travelling through time, which is the same
   * mistake as taking identity from message content — just with a longer delay.
   */
  const role = roleFor(followup.senderHandle, deps.config);
  /**
   * 🔴 WHO MAY BE SPOKEN TO DEPENDS ON THE KIND, NOT ON A SINGLE RULE.
   *
   * The owner-only rule is correct for `restore-qbit-throttle`: that reports
   * homelab state, which guests do not get. Applying it to `media-add` would
   * REPRODUCE THE EXACT DEFECT this feature exists to fix — the live Peppa Pig
   * case was a GUEST, and a follow-up that silently declines to tell them is
   * indistinguishable from never following up at all.
   *
   * A media add is the requester's OWN request, and Jeff has granted guests real
   * media writes. They are told about their own request; they are still told
   * nothing about the homelab.
   */
  /**
   * `ebook-deliver` speaks to anyone for the same reason `media-add` does: it is
   * the requester's OWN book, they were already told it was coming, and staying
   * silent would reproduce the exact defect this kind exists to fix.
   */
  const maySpeak =
    followup.kind === 'media-add' ||
    followup.kind === 'ebook-deliver' ||
    /**
     * A refused book is the requester's own bad news and the fix (`E014`: add
     * the sender in Amazon) is something only THEY can do. Withholding it from a
     * guest would leave them waiting on a book that was thrown away — the exact
     * silence this whole area exists to end.
     */
    followup.kind === 'kindle-verify'
      ? true
      : role === 'owner';
  const speak = async (text: string): Promise<boolean> => {
    if (!maySpeak) return false;
    await deps.send(followup.senderHandle, text);
    return true;
  };

  const why =
    `Following up on my own initiative, ${describeAge(followup.createdAt, now)} after I ` +
    `${followup.reason}\nWhat I saw then: ${followup.observed}`;

  if (followup.kind === 'media-add') {
    return runMediaAdd(followup, store, deps, now, speak, why);
  }

  if (followup.kind === 'ebook-deliver') {
    return runEbookDeliver(followup, store, deps, now, speak, why);
  }

  if (followup.kind === 'kindle-verify') {
    return runKindleVerify(followup, store, deps, now, speak, why);
  }

  // ── What is actually in force right now? ───────────────────────────────────
  const state = await readThrottleState(ctx);
  if (!state.known) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `could not read qBittorrent's state (${state.detail})`,
      async () =>
        speak(
          `${why}\n\nI came back to take that throttle off and I CANNOT TELL whether it is still on — ` +
            `${state.detail}. I have stopped retrying. qBittorrent may still be limited to ` +
            `${kb(SHED_DOWN_BYTES_PER_SEC)} down / ${kb(SHED_UP_BYTES_PER_SEC)} up, and I would rather ` +
            'say that than guess. Worth a look when you have a moment.',
        ),
    );
  }

  if (!state.throttled) {
    // Nothing to undo, and nothing anyone needs to hear about it. An unprompted
    // "I checked and there was nothing to do" is exactly the noise that teaches
    // people to ignore this channel.
    store.resolve(followup.id, 'done', 'throttle was already off; nothing to undo', now);
    return { id: followup.id, action: 'nothing-to-do', sent: false, detail: 'throttle already off' };
  }

  if (!state.ours) {
    const detail =
      `alternate limits are ${state.altDown}/${state.altUp} B/s, not the ${SHED_DOWN_BYTES_PER_SEC}/` +
      `${SHED_UP_BYTES_PER_SEC} I set`;
    store.resolve(followup.id, 'abandoned', `not ours: ${detail}`, now);
    const sent = await speak(
      `${why}\n\nI came back to take my throttle off, but qBittorrent is now limited by settings that ` +
        `are not mine (${detail}). Someone or something else changed them, so I have left them alone. ` +
        'My own throttle is no longer what is in force.',
    );
    return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail };
  }

  // ── Would lifting it hurt anyone right now? ───────────────────────────────
  //
  // Restoring INCREASES host load, so this is the direction that can disturb a
  // viewer. The same rule as everywhere else: an unreadable /Sessions is UNKNOWN
  // and UNKNOWN refuses.
  const get = deps.jellyfin ?? jellyfinGet;
  const sessionsRes = await get(deps.config, '/Sessions');
  const playback = sessionsRes.ok
    ? parseSessions(sessionsRes.body)
    : { known: false, activeSessions: [], detail: `/Sessions unreadable: ${sessionsRes.error}` };

  if (!playback.known) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `cannot tell whether anyone is watching (${playback.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled and I have NOT lifted it: I cannot tell whether ` +
            `anyone is watching (${playback.detail}), and lifting it puts load back on the box. I have ` +
            'stopped retrying — run restore_qbit_speed when you know the coast is clear.',
        ),
    );
  }
  if (playback.activeSessions.length > 0) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `someone is watching (${playback.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled. I have left it that way because someone has been ` +
            `watching every time I checked (${playback.detail}), and lifting it puts load back on the ` +
            'box. It is not hurting anything where it is — tell me when you want it back.',
        ),
    );
  }

  // ── Is the box actually better? ───────────────────────────────────────────
  //
  // 🔴 ONLY `clear` licenses lifting it. Every other known verdict means the box
  // is still contended, and putting the load back would undo the fix.
  //
  // ⚠️ `qbit-not-the-cause` in particular must NOT be read as "the shed was
  // pointless, so undo it". While the throttle is ON, qBittorrent's throughput
  // is capped by definition — so a successful shed MAKES qBittorrent look
  // innocent. Treating that as grounds to lift would produce a loop: lift,
  // contend, shed, look innocent, lift. **A measurement taken through your own
  // intervention is not independent of it.**
  const observation = await observeContention(ctx);
  if (observation.verdict === 'unknown') {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `could not measure the host (${observation.detail})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is still throttled and I have NOT lifted it, because I could not ` +
            `measure whether the box is better: ${observation.detail} I have stopped retrying rather ` +
            'than lift a limit on a guess.',
        ),
    );
  }
  if (observation.verdict !== 'clear') {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `host still contended (${observation.verdict})`,
      async () =>
        speak(
          `${why}\n\nqBittorrent is STILL throttled and I am leaving it that way: the box is still ` +
            `loaded — ${observation.detail}\nTaking the limit off now would put that load straight back. ` +
            'I have stopped checking; run restore_qbit_speed when you want it back.',
        ),
    );
  }

  // ── Lift it, and verify with the tool that checks its own work ────────────
  const restore = await restoreQbitSpeed.run({}, { ...ctx, config: { ...deps.config, readOnly: false } });
  if (!restore.ok) {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `restore failed (${restore.content})`,
      async () =>
        speak(
          `${why}\n\nThe box looks fine now (${observation.detail}) so I tried to take the throttle off, ` +
            `and the restore FAILED: ${restore.content}\nqBittorrent may still be limited.`,
        ),
    );
  }

  store.resolve(followup.id, 'done', 'throttle lifted and verified', now);
  const sent = await speak(
    `${why}\n\nThe box is fine now — ${observation.detail}\n` +
      `Nobody is watching (${playback.detail}), so I have taken the throttle off: ${restore.content}`,
  );
  return {
    id: followup.id,
    action: sent ? 'restored' : 'not-delivered',
    sent,
    detail: 'throttle lifted and verified',
  };
}

/**
 * Try again later, or give up and SAY so.
 *
 * The give-up message is the point. A follow-up that quietly stops retrying has
 * left a change on the box that nobody knows about, which is the state this
 * whole module exists to prevent.
 */
async function deferOrGiveUp(
  followup: Followup,
  store: FollowupStore,
  now: Date,
  note: string,
  giveUpMessage: () => Promise<boolean>,
  /** Defaults to the generic retry gap; ebook deliveries come back sooner. */
  delayMs: number = RETRY_DELAY_MS,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<FollowupOutcome> {
  const deferred = store.defer(followup.id, new Date(now.getTime() + delayMs), note, now, maxAttempts);
  if (deferred) {
    return { id: followup.id, action: 'deferred', sent: false, detail: note };
  }
  store.resolve(followup.id, 'abandoned', note, now);
  const sent = await giveUpMessage();
  return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail: note };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB/s`;
}

function describeAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return 'some time';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * A media add came due: go and look, then TELL THE PERSON.
 *
 * 🔴 The requirement is not "the add succeeded" — it is **the user learns the
 * outcome**. The live case this exists for had a REAL, successful add: V1 said
 * *"I'll check back in a bit"*, seasons 2 and 3 never arrived, and five months
 * later the user had still been told nothing. **A write that completes and never
 * reports back is a defect even when the write worked.**
 *
 * So `none` is NEWS, not silence. It is the branch that failed in production.
 */
async function runMediaAdd(
  followup: Followup,
  store: FollowupStore,
  deps: FollowupDeps,
  now: Date,
  speak: (text: string) => Promise<boolean>,
  why: string,
): Promise<FollowupOutcome> {
  const subject = followup.subject;
  if (!subject) {
    store.resolve(followup.id, 'abandoned', 'no subject recorded', now);
    return { id: followup.id, action: 'abandoned', sent: false, detail: 'no subject recorded' };
  }
  const arrConfig = subject.arr === 'series' ? deps.config.sonarr : deps.config.radarr;
  const client = new ArrClient(arrConfig, subject.arr);

  if (deps.plex) {
    const view = await deps.plex.available({
      arr: subject.arr,
      id: subject.id,
      seasons: subject.seasons,
      now,
    });
    if (view.state === 'ready') {
      const sent = await speak(availabilityLine(subject.title, subject.arr, subject.seasons));
      store.resolve(followup.id, 'done', 'on plex', now);
      return { id: followup.id, action: 'restored', sent, detail: 'on plex' };
    }
    if (view.state === 'unknown') {
      return await deferOrGiveUp(
        followup,
        store,
        now,
        `could not check Plex for "${subject.title}"`,
        () => speak(`I couldn't confirm whether ${subject.title} is on Plex, so I have stopped checking.`),
        MEDIA_RECHECK_MS,
      );
    }
    // not-ready falls through. An arr import is not availability.
  }

  const p = await client.progress(subject.id, subject.seasons);

  // Cannot establish the state -> defer and say so when out of deferrals. Never
  // guess, and never report "nothing arrived" when the truth is "I could not look".
  if (p.state === 'unknown') {
    return await deferOrGiveUp(
      followup,
      store,
      now,
      `could not check on "${subject.title}": ${p.detail}`,
      () => speak(`I could not check on "${subject.title}", so I have stopped.`),
      MEDIA_RECHECK_MS,
    );
  }

  if (p.state === 'complete') {
    if (deps.plex) {
      return await deferOrGiveUp(
        followup,
        store,
        now,
        `not on plex yet: ${p.detail}`,
        () => speak(`I stopped waiting on ${subject.title}. It is not on Plex yet.`),
        MEDIA_RECHECK_MS,
      );
    }
    const sent = await speak(
      `I cannot check Plex from here, so I will not call "${subject.title}" available.`,
    );
    store.resolve(followup.id, 'done', `complete, plex unchecked: ${p.detail}`, now);
    return { id: followup.id, action: 'restored', sent, detail: p.detail };
  }

  if (p.state === 'partial') {
    // Some arrived, some did not. Report progress and keep watching, because the
    // interesting outcome is the part that never lands.
    const deferred = store.defer(followup.id, new Date(now.getTime() + MEDIA_RECHECK_MS), p.detail, now);
    if (deferred) {
      return { id: followup.id, action: 'deferred', sent: false, detail: `partial: ${p.detail}` };
    }
    const sent = await speak(
      `${p.detail}. Some of it arrived and the rest has not, and I have stopped watching for it.`,
    );
    store.resolve(followup.id, 'abandoned', `partial at give-up: ${p.detail}`, now);
    return { id: followup.id, action: 'abandoned', sent, detail: p.detail };
  }

  // 🔴 NOTHING ARRIVED. This is the Peppa Pig branch, and the whole point is
  // that it SPEAKS rather than going quiet.
  const deferred = store.defer(followup.id, new Date(now.getTime() + MEDIA_RECHECK_MS), p.detail, now);
  if (deferred) {
    return { id: followup.id, action: 'deferred', sent: false, detail: `nothing yet: ${p.detail}` };
  }
  const sent = await speak(
    `${p.detail} — nothing has downloaded, and it will not arrive on its own. I have stopped waiting.`,
  );
  store.resolve(followup.id, 'abandoned', `nothing arrived: ${p.detail}`, now);
  return { id: followup.id, action: 'abandoned', sent, detail: p.detail };
}

/**
 * 🔴 THE BRANCH THAT CLOSES A LIVE DEFECT.
 *
 * Before this existed, `send_ebook` told people their book was downloading and
 * then nothing on any path ever delivered it or told them otherwise. This is the
 * code that makes that promise true — or, when it cannot, says so out loud
 * instead of going quiet.
 *
 * Both sources land here. The torrent path polls qBittorrent; the IRC path makes
 * its request HERE rather than in the turn, because a bot may queue for ten
 * minutes and a turn cannot wait that long.
 */
async function runEbookDeliver(
  followup: Followup,
  store: FollowupStore,
  deps: FollowupDeps,
  now: Date,
  speak: (text: string) => Promise<boolean>,
  why: string,
): Promise<FollowupOutcome> {
  const subject = followup.ebook;
  if (!subject) {
    store.resolve(followup.id, 'abandoned', 'no ebook subject recorded', now);
    return { id: followup.id, action: 'abandoned', sent: false, detail: 'no ebook subject' };
  }

  // Missing plumbing is reported to the PERSON, not just logged. They were told
  // a book was coming; a deployment gap must not become their silence.
  if (!deps.kindle || !deps.mail) {
    const detail = 'this deployment cannot send books (no address store or no mail sender)';
    const sent = await speak(bookFailureLine(subject.title, detail));
    store.resolve(followup.id, 'abandoned', detail, now);
    return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail };
  }

  const r = await deliverEbook(
    subject,
    followup.senderHandle,
    {
      config: deps.config,
      kindle: deps.kindle,
      mail: deps.mail,
      ...(deps.exec ? { exec: deps.exec } : {}),
      ...(deps.irc ? { irc: deps.irc } : {}),
      ...(deps.mounts ? { mounts: deps.mounts } : {}),
      ...(deps.sabFetch ? { sabFetch: deps.sabFetch } : {}),
      followups: store,
      ...(deps.onlySendTo ? { onlySendTo: deps.onlySendTo } : {}),
    },
    { mayBlock: true },
  );

  if (r.state === 'delivered') {
    const sent = await speak(bookEmailed(subject.title));
    store.resolve(followup.id, 'done', r.detail, now);
    return { id: followup.id, action: 'restored', sent, detail: r.detail };
  }

  if (r.state === 'failed') {
    // Terminal and bad. This ALWAYS speaks: a book that is never coming is
    // precisely what the person needs to hear. One line, not a progress report.
    const sent = await speak(bookFailureLine(subject.title, r.detail));
    store.resolve(followup.id, 'abandoned', r.detail, now);
    return { id: followup.id, action: sent ? 'abandoned' : 'not-delivered', sent, detail: r.detail };
  }

  // `waiting` and `unknown` both mean "no verdict yet". Defer, and when the
  // deferrals run out say plainly that we stopped — never just fall silent.
  const gap = deps.config.ebookRecheckMs;
  return await deferOrGiveUp(
    followup,
    store,
    now,
    `"${subject.title}": ${r.detail}`,
    () => speak(bookStoppedWaiting(subject.title)),
    gap,
    ebookAttemptCeiling(gap),
  );
}

/**
 * 🔴 THE BRANCH THIS WHOLE INSTRUMENT EXISTS FOR.
 *
 * Amazon accepts the SMTP transaction and THEN, minutes later, emails a refusal
 * to the sending account. Jedd never saw those. So after every send the standing
 * state was: *"it has been sent and I cannot tell you whether it arrived, and I
 * never will."* This is the code that goes and looks.
 *
 * ── WHAT IT WILL AND WILL NOT SAY ────────────────────────────────────────────
 *
 * It reports REFUSAL. It never reports delivery, because Amazon sends no
 * acceptance notice and discards mail to a nonexistent address in silence —
 * there is no positive signal in this channel to wait for.
 *
 * `no-failure-seen` is therefore DELIBERATELY SILENT. The person has already
 * been told the book was sent and that this is not confirmation; an unprompted
 * *"I checked and found nothing, which proves nothing"* is precisely the noise
 * that teaches people to ignore this channel.
 *
 * `blind` goes to the OWNER, not the requester. A check that cannot see is an
 * operator problem: nothing has changed for the person who asked for the book,
 * who was told the true thing at send time and is still owed no correction.
 */
async function runKindleVerify(
  followup: Followup,
  store: FollowupStore,
  deps: FollowupDeps,
  now: Date,
  speak: (text: string) => Promise<boolean>,
  why: string,
): Promise<FollowupOutcome> {
  const subject = followup.verify;
  if (!subject) {
    store.resolve(followup.id, 'abandoned', 'no verify subject recorded', now);
    return { id: followup.id, action: 'abandoned', sent: false, detail: 'no verify subject' };
  }

  /**
   * 🔴 A MISSING READER DEFERS; IT DOES NOT DISCARD THE CHECK.
   *
   * `src/index.ts` builds a FollowupStore over the SAME log file as the daemon
   * and ticks it WITHOUT a mailbox reader. Resolving here meant a chat session
   * could permanently destroy a check the daemon had scheduled — and the daemon
   * would never look again, because the record was closed. Deferring leaves it
   * for whichever runner does have a reader.
   *
   * And when it really does run out: the OWNER hears about it, not the
   * requester. A deployment with no IMAP credentials is an operator problem, and
   * telling a guest about it every single time a book goes out is guaranteed
   * noise they cannot act on.
   */
  if (!deps.mailbox) {
    return asBlind(await deferOrGiveUp(
      followup,
      store,
      now,
      'no mailbox reader on this runner',
      () => alertOwner(deps, followup.senderHandle, subject.title, subject.sentAt,
        'This runner cannot read the mailbox Amazon replies to (no IMAP credentials), so refusals ' +
        'are going undetected.'),
      VERIFY_RETRY_MS,
    ));
  }

  const result = await verifyKindleDelivery(
    deps.mailbox,
    { sentAt: new Date(subject.sentAt), filename: subject.filename },
    now,
  );

  if (result.state === 'failed' || result.state === 'failed-unattributed') {
    /**
     * 🔴 THE TELLING IS RETRIED, NOT ABANDONED, IF IT FAILS.
     *
     * `speak` was awaited outside a catch: a connector hiccup threw, the outer
     * handler resolved the record `abandoned`, and the one message this whole
     * feature exists to deliver was lost with no retry. The blind branch already
     * guarded its send for exactly this reason; the branch carrying the actual
     * bad news did not.
     */
    const text =
      result.state === 'failed'
        ? `${why}\n\n🔴 It did NOT go through. ${result.detail}\n` +
          'Nothing arrived on your Kindle, and it will not arrive on its own.'
        : `${why}\n\n⚠️ ${result.detail}\n` +
          `Have a look for "${subject.title}" on your Kindle — if it is not there, that refusal was ` +
          'probably yours.';
    let sent = false;
    try {
      sent = await speak(text);
    } catch (e) {
      return await deferOrGiveUp(
        followup,
        store,
        now,
        `could not tell them about the refusal: ${(e as Error).message}`,
        async () =>
          alertOwner(deps, followup.senderHandle, subject.title, subject.sentAt,
            `Amazon refused it (${result.code}) and I could not deliver that message to them.`),
        VERIFY_RETRY_MS,
      );
    }
    store.resolve(followup.id, 'done', `refused: ${result.code} — ${result.reason} (${result.state})`, now);
    return {
      id: followup.id,
      action: sent ? 'refusal-reported' : 'not-delivered',
      sent,
      detail: `${result.code} — ${result.reason}`,
    };
  }

  if (result.state === 'no-failure-seen') {
    /**
     * 🔴 ONE CONFIRMING LOOK BEFORE CLOSING.
     *
     * The 12-minute delay comes from the notices already in the mailbox — a
     * handful of samples of Amazon's latency, with nothing said about the tail.
     * A refusal that lands at minute 20 against a single check at minute 12
     * restores exactly the silence this feature exists to end. The second look
     * costs one mailbox session and closes that gap; it is bounded at one,
     * because a checker that never stops looking never reports either.
     */
    if (followup.attempts === 0 && store.defer(followup.id, new Date(now.getTime() + LATE_RECHECK_MS), 'nothing yet; one more look', now)) {
      return { id: followup.id, action: 'deferred', sent: false, detail: 'no refusal yet; looking once more' };
    }
    store.resolve(followup.id, 'done', `no refusal found: ${result.detail}`, now);
    return { id: followup.id, action: 'no-failure-seen', sent: false, detail: result.detail };
  }

  // ── blind: defer, and when the deferrals run out tell the OWNER ────────────
  return asBlind(
    await deferOrGiveUp(
      followup,
      store,
      now,
      result.detail,
      () => alertOwner(deps, followup.senderHandle, subject.title, subject.sentAt, result.detail),
      VERIFY_RETRY_MS,
    ),
  );
}

/**
 * Label a give-up on this path `blind` rather than the generic `abandoned`.
 *
 * The action string is what lands in the operator's follow-up log line. "This
 * check stopped because it could not SEE" and "this check stopped" are different
 * facts, and only the first one names something that needs fixing.
 */
function asBlind(outcome: FollowupOutcome): FollowupOutcome {
  if (outcome.action === 'deferred') return outcome;
  return { ...outcome, action: 'blind' };
}

/**
 * Tell the owner that the delivery check itself is in trouble.
 *
 * Never throws: the record's outcome is already written, and a failed alert must
 * not turn into an exception that resolves the follow-up as "threw".
 */
async function alertOwner(
  deps: FollowupDeps,
  requester: string,
  title: string,
  sentAt: string,
  detail: string,
): Promise<boolean> {
  try {
    await deps.send(
      deps.config.ownerHandle,
      `Heads up: my Kindle delivery check is BLIND and has stopped retrying for "${title}" ` +
        `(sent ${sentAt}, for ` +
        `${requester}).\n${detail}\nNobody has been told anything wrong — the requester was told it ` +
        'was sent, which is true. But refusals are going undetected until this is fixed.',
    );
    return true;
  } catch {
    return false;
  }
}
