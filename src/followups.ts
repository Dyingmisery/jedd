import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable follow-ups: the thing that wakes up and can speak without being asked.
 *
 * ── WHY THIS EXISTS, CONCRETELY ──────────────────────────────────────────────
 *
 * `shed_host_load` throttles qBittorrent and **nothing will ever take that
 * throttle off on its own.** The tool cannot wait: the fix needs minutes or
 * hours to be judged, and a turn that ends when the tool returns has not
 * finished the job. "A turn ends when the user has been told the outcome" is not
 * deliverable inside a twenty-second settle window.
 *
 * So this module is deliberately NOT a general scheduler. It exists to close a
 * gap in a specific shipped behaviour, and the kinds are a code-owned enum.
 *
 * ── 🔴 THE RULE FOR ANYTHING THAT WAKES UP ───────────────────────────────────
 *
 * **A follow-up that fires when nobody is listening is worse than none.** So
 * every record carries, written at the moment it was scheduled:
 *   - WHY it was scheduled (`reason`)
 *   - TO WHOM it must speak (`senderHandle`)
 *   - WHAT was observed at the time (`observed`)
 *
 * and the runner must **refuse rather than guess** when it cannot establish the
 * current state. An unprompted message from a machine that cannot say why it is
 * talking to you is noise; one that acts on a guess is worse than noise.
 */

/** Code-owned. The model cannot introduce a new kind of follow-up. */
export type FollowupKind =
  | 'restore-qbit-throttle'
  | 'media-add'
  | 'ebook-deliver'
  | 'kindle-verify';

/**
 * What a `media-add` follow-up is about.
 *
 * 🔴 THE REQUIREMENT THIS SERVES: **a turn ends when the user has been told the
 * outcome, not when the tool returned.**
 *
 * Live instance from V1, 2026-04-02: a guest asked for *Peppa Pig* seasons 1-3.
 * The add was REAL — Sonarr shows it 8 seconds later — and V1 said *"I'll check
 * back in a bit and let you know when they're ready."* Five months on, seasons 2
 * and 3 have **zero files** and the user was never told anything.
 *
 * The add succeeding is not the outcome. **The user learning what happened is.**
 */
export interface MediaAddSubject {
  arr: 'series' | 'movie';
  /** tvdbId for a series, tmdbId for a movie — never the internal row id. */
  id: number;
  title: string;
  /** Empty for a movie. For a series, ONLY the seasons actually requested. */
  seasons: number[];
}

/**
 * What an `ebook-deliver` follow-up is about.
 *
 * ── 🔴 THE DEFECT THIS FIXES, WHICH PREDATES IRC ────────────────────────────
 *
 * `send_ebook` grabbed a torrent and, if it had not finished, returned
 * *"DOWNLOADING — ... Tell them it is downloading and that you will send it once
 * it lands."* **Nothing ever followed up.** No scheduler, no job, no second
 * look. The user was told a book was coming and the process that would deliver
 * it did not exist.
 *
 * That is the Peppa Pig defect exactly, one flow over: *the add succeeding is
 * not the outcome — the user learning what happened is.* It was live on the
 * shipping torrent path, not something the IRC work introduced.
 *
 * ── 🔴 THE DELIVERY ADDRESS IS DELIBERATELY NOT STORED HERE ─────────────────
 *
 * Only the `senderHandle` is. The address is re-read from `KindleRegistry` at
 * FIRE time, for the same reason `roleFor()` is re-derived rather than trusted
 * from the record: a stored address is a delivery target travelling through
 * time, and this is the one path where getting that wrong means **a stranger
 * receives someone's book** — which has happened here once already.
 */
export interface EbookDeliverSubject {
  /** Which fetcher completes this. The model never supplies it. */
  source: 'prowlarr' | 'irc' | 'sab';
  title: string;
  /** Prowlarr torrent only: the torrent to watch for. */
  infoHash?: string;
  /** IRC only: the exact channel command, and the bot that must still be present. */
  command?: string;
  bot?: string;
  /**
   * SABnzbd only. Persisted on the follow-up so a restart polls this job
   * instead of submitting the NZB again.
   */
  nzoId?: string;
}

/**
 * What a `kindle-verify` follow-up is about.
 *
 * ── 🔴 THE ASYMMETRY THIS EXISTS FOR ─────────────────────────────────────────
 *
 * **Amazon's success is silent and its failure is out-of-band.** A refusal —
 * `E014 - Unapproved sender email address` is the one a new recipient actually
 * hits — arrives as email to the SENDING account minutes after the SMTP hand-off
 * has already returned a clean 250. Nothing inside the turn can see it, so the
 * person is told their book was sent and then nothing ever contradicts it.
 *
 * That is why the check is a follow-up rather than a step in the send: **the
 * evidence does not exist yet when the send finishes.**
 *
 * 🔴 `sentAt` IS THE LOAD-BEARING FIELD. Every one of Amazon's notices carries
 * the identical subject line, and the mailbox holds years of them. Without a
 * lower bound taken at the moment of the hand-off, a bounce from April is
 * indistinguishable from a bounce for tonight's book — the check would
 * manufacture failures for good sends.
 */
export interface KindleVerifySubject {
  /** The attached filename, which Amazon quotes back in most refusals. */
  filename: string;
  /** Human-facing name of the book, for the message this may end up sending. */
  title: string;
  /** ISO instant of the SMTP hand-off. Nothing before this can be about it. */
  sentAt: string;
}

export interface Followup {
  id: string;
  kind: FollowupKind;
  senderHandle: string;
  createdAt: string;
  dueAt: string;
  /** Why this was scheduled, in words, for the message it will eventually send. */
  reason: string;
  /** What was observed when it was scheduled, so the follow-up can say what changed. */
  observed: string;
  /** Set for `media-add`: what to go and check when this comes due. */
  subject?: MediaAddSubject;
  /** Set for `ebook-deliver`: the book to finish delivering. */
  ebook?: EbookDeliverSubject;
  /** Set for `kindle-verify`: the send to go looking for a refusal of. */
  verify?: KindleVerifySubject;
  /** How many times this has come due and been deferred. Bounded — see MAX_ATTEMPTS. */
  attempts: number;
  status: 'pending' | 'done' | 'abandoned';
  outcome?: string;
}

type LogRecord =
  | { type: 'schedule'; followup: Followup }
  | { type: 'defer'; id: string; at: string; dueAt: string; note: string }
  | { type: 'resolve'; id: string; at: string; status: 'done' | 'abandoned'; outcome: string };

/**
 * How many times a follow-up may come due, fail to reach a verdict, and be
 * rescheduled before it gives up and says so.
 *
 * Bounded on purpose: an unbounded retry is how a machine ends up quietly
 * checking something forever and never telling anyone it could not finish.
 */
export const MAX_ATTEMPTS = 4;

export class FollowupStore {
  private readonly items = new Map<string, Followup>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(trimmed) as LogRecord;
      } catch {
        continue;
      }
      if (rec.type === 'schedule') {
        this.items.set(rec.followup.id, { ...rec.followup });
      } else if (rec.type === 'defer') {
        const item = this.items.get(rec.id);
        if (item) {
          item.dueAt = rec.dueAt;
          item.attempts += 1;
        }
      } else if (rec.type === 'resolve') {
        const item = this.items.get(rec.id);
        if (item) {
          item.status = rec.status;
          item.outcome = rec.outcome;
        }
      }
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  schedule(input: {
    kind: FollowupKind;
    senderHandle: string;
    dueAt: Date;
    reason: string;
    observed: string;
    subject?: MediaAddSubject;
    ebook?: EbookDeliverSubject;
    verify?: KindleVerifySubject;
    now?: Date;
  }): Followup {
    const now = input.now ?? new Date();
    const followup: Followup = {
      id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      senderHandle: input.senderHandle,
      createdAt: now.toISOString(),
      dueAt: input.dueAt.toISOString(),
      reason: input.reason,
      observed: input.observed,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.ebook ? { ebook: input.ebook } : {}),
      ...(input.verify ? { verify: input.verify } : {}),
      attempts: 0,
      status: 'pending',
    };
    this.append({ type: 'schedule', followup });
    this.items.set(followup.id, followup);
    return followup;
  }

  /**
   * Is there already a pending follow-up of this kind?
   *
   * Scheduling a second un-throttle for a throttle that is already being watched
   * would produce two unprompted messages about one event.
   */
  pendingOfKind(kind: FollowupKind): Followup | undefined {
    return [...this.items.values()].find((f) => f.kind === kind && f.status === 'pending');
  }

  /**
   * Is this exact title already being followed up for this person?
   *
   * Scheduling a second watch for the same add would produce two unprompted
   * messages about one event — the same reason `pendingOfKind` exists, but a
   * media add is per-title rather than one-at-a-time, so the key is finer.
   */
  /**
   * Is this person already waiting on this exact book?
   *
   * Same reason as `pendingForSubject`: a second follow-up for one request would
   * produce two unprompted messages about one book, and — worse here than for a
   * media add — could deliver it to their Kindle twice.
   */
  pendingEbook(senderHandle: string, title: string): Followup | undefined {
    return [...this.items.values()].find(
      (f) =>
        f.status === 'pending' &&
        f.kind === 'ebook-deliver' &&
        f.senderHandle === senderHandle &&
        f.ebook?.title === title,
    );
  }

  pendingForSubject(senderHandle: string, arr: string, id: number): Followup | undefined {
    return [...this.items.values()].find(
      (f) =>
        f.status === 'pending' &&
        f.senderHandle === senderHandle &&
        f.subject?.arr === arr &&
        f.subject?.id === id,
    );
  }

  due(now = new Date()): Followup[] {
    return [...this.items.values()]
      .filter((f) => f.status === 'pending' && Date.parse(f.dueAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  /** Push a follow-up out, counting the attempt. Returns false once exhausted. */
  defer(id: string, until: Date, note: string, at = new Date()): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.attempts + 1 >= MAX_ATTEMPTS) return false;
    this.append({ type: 'defer', id, at: at.toISOString(), dueAt: until.toISOString(), note });
    item.dueAt = until.toISOString();
    item.attempts += 1;
    return true;
  }

  resolve(id: string, status: 'done' | 'abandoned', outcome: string, at = new Date()): void {
    const item = this.items.get(id);
    if (!item) return;
    this.append({ type: 'resolve', id, at: at.toISOString(), status, outcome });
    item.status = status;
    item.outcome = outcome;
  }

  all(): Followup[] {
    return [...this.items.values()];
  }
}
