import type { Config } from '../config.js';
import type { EbookDeliverSubject } from '../followups.js';
import type { ExecImpl } from '../hp.js';
import type { KindleRegistry } from '../kindle.js';
import { mayRequestKindle, sameHandle } from '../permissions.js';
import { validateEbookBytes } from './ebook-validate.js';
import { fetchFileFromHp, resolveBookPath } from './fetch-file.js';
import { grabStatus, toHostPath, type MountMap } from './grab.js';
import type { IrcEbooks } from './irc-ebooks.js';
import { sendToKindle, type MailSender } from './kindle-send.js';
import { readContainedBook } from './sab-files.js';
import { SabnzbdClient, type FetchImpl } from './sabnzbd.js';

/**
 * The last leg of an ebook, shared by BOTH sources and by both callers.
 *
 * `send_ebook` calls it once inside the turn (fast path: the torrent may already
 * be on disk). The follow-up runner calls it again later, when the turn is long
 * over. One function, so the validation and the delivery cannot drift apart
 * between the two paths — and so the Kindle address is read from exactly one
 * place either way.
 *
 * 🔴 THE VALIDATOR SITS HERE, IN FRONT OF `sendToKindle`, FOR BOTH SOURCES.
 * An indexer is no more trustworthy than an IRC bot. Nothing reaches the mail
 * step without its bytes being identified first.
 */

export function bookRequestAdded(title: string): string {
  return `Your request for ${title} has been added.`;
}

export function bookAlreadyRequested(title: string): string {
  return `Your request for ${title} is already in.`;
}

/** SMTP accepted the message. This is not a claim the device has it. */
export function bookEmailed(title: string): string {
  return `${title} has been emailed to your Kindle address.`;
}

export function bookCouldNotAdd(title: string): string {
  return `I could not add ${title}. Nothing was sent.`;
}

export function bookCouldNotEmail(title: string): string {
  return `I could not email ${title}. Nothing was sent. I have stopped trying.`;
}

export function bookStoppedWaiting(title: string): string {
  return `I stopped waiting for ${title}. It has not been emailed.`;
}

export function bookNoEpub(title: string): string {
  return `I couldn't find an EPUB of ${title}.`;
}

export function bookFailureLine(title: string, detail: string): string {
  if (/Send-to-Kindle address/i.test(detail)) return detail;
  if (/may already have gone/i.test(detail)) {
    return `I could not tell whether ${title} was emailed. I have not tried again, because it may already have gone.`;
  }
  if (/not an EPUB/i.test(detail)) return bookNoEpub(title);
  if (/WINDOWS EXECUTABLE/i.test(detail)) {
    return `I could not email ${title}. The file was not a book. Nothing was sent. I have stopped trying.`;
  }
  return bookCouldNotEmail(title);
}

export type DeliverOutcome =
  /**
   * Handed to the mail server. Terminal, and the user should be told.
   *
   * ⚠️ The NAME is historical and the state does not mean what it says: it means
   * SMTP accepted the bytes. Amazon may still refuse them minutes later, which
   * is what `kindle-verify` goes looking for — see `filename`/`sentAt`, which
   * exist so that check can be aimed at this exact send.
   */
  | { state: 'delivered'; detail: string; filename: string; sentAt: string }
  /** Not here yet, no error. Come back later; do NOT tell the user it arrived. */
  | { state: 'waiting'; detail: string }
  /** Terminal and bad. The user must be told plainly. */
  | { state: 'failed'; detail: string }
  /** Could not establish anything. Defer rather than guess. */
  | { state: 'unknown'; detail: string };

export interface DeliverDeps {
  config: Config;
  kindle: KindleRegistry;
  mail: MailSender;
  /**
   * 🔴 WHERE THE DELIVERY CHECK IS SCHEDULED, AND WHY IT IS SCHEDULED HERE.
   *
   * The same argument the `onlySendTo` note below makes: this is the shared leg.
   * `send_ebook` and the follow-up runner BOTH reach the SMTP hand-off through
   * this function, so putting the scheduling at either call site means one of
   * them can be added later without it — and the missing one would be the path
   * that sends a book and never checks whether Amazon threw it away.
   *
   * Optional because a deployment without a follow-up store must still be able
   * to send. When it is absent the outcome SAYS the send is unchecked, rather
   * than reading identically to a checked one.
   */
  followups?: FollowupScheduler;
  exec?: ExecImpl;
  irc?: IrcEbooks;
  /** Test seam for SABnzbd. Unset in production. */
  sabFetch?: FetchImpl;
  mounts?: MountMap[];
  /**
   * 🔴 THE LIVE-TEST RESTRICTION LIVES HERE, NOT ONLY IN THE TOOL.
   *
   * `send_ebook` argues its `onlySendTo` is safe because the restricted build is
   * "a DIFFERENT OBJECT, not the same object in a different mood". The follow-up
   * runner bypassed that object entirely — it calls `deliverEbook` directly with
   * the raw mail sender. Not reachable today, because the tool refuses before
   * scheduling; but a follow-up OUTLIVES the turn that wrote it and can outlive
   * an `OWNER_HANDLE` change, which is the same reason the runner already
   * re-derives `role` instead of trusting the record. Putting the gate on the
   * shared leg means both callers inherit it and neither has to remember.
   */
  onlySendTo?: string;
}

export async function deliverEbook(
  subject: EbookDeliverSubject,
  senderHandle: string,
  deps: DeliverDeps,
  opts: { mayBlock: boolean },
): Promise<DeliverOutcome> {
  /**
   * 🔴 THE ADDRESS IS READ NOW, NOT TAKEN FROM THE FOLLOW-UP RECORD.
   *
   * V1 once persisted a model-invented address and a stranger received someone's
   * book. The gate against that is that an address only ever comes from the
   * registry, keyed by the person asking — never from a parameter, and never
   * from a record written minutes or hours ago that may since have changed.
   */
  if (!mayRequestKindle(senderHandle, deps.config, deps.onlySendTo)) {
    return {
      state: 'failed',
      detail: 'ebook sending is not enabled for this sender. Nothing was sent.',
    };
  }

  // The recipient is the address the owner already saved. A guest does not
  // get their own, and cannot name a different one.
  const record = deps.kindle.get(deps.config.ownerHandle);
  if (!record) {
    return {
      state: 'failed',
      detail: sameHandle(senderHandle, deps.config.ownerHandle)
        ? 'I do not have a Send-to-Kindle address saved for you, so I could not send it. ' +
          'Tell me your @kindle.com address and I will finish this.'
        : 'No Kindle address is configured. Nothing was sent.',
    };
  }

  const got =
    subject.source === 'irc'
      ? await fetchViaIrc(subject, deps, opts.mayBlock)
      : subject.source === 'sab'
        ? await fetchViaSab(subject, deps)
        : await fetchViaTorrent(subject, deps);
  if (got.state !== 'ok') return got;

  // ── identify the bytes before anything else touches them ──────────────────
  const verdict = validateEbookBytes(got.filename, got.bytes);
  if (verdict.state !== 'ok') {
    return {
      state: 'failed',
      detail: `I did not send it: ${verdict.detail} Nothing was forwarded to your Kindle.`,
    };
  }

  /**
   * 🔴 TAKEN BEFORE THE HAND-OFF, NOT AFTER IT.
   *
   * This instant is the lower bound of the window the delivery check searches,
   * and every Amazon refusal notice carries the same subject line — so it is the
   * only thing separating "a bounce for this book" from "a bounce for a book in
   * April". Reading the clock AFTER the await meant the SMTP round trip sat
   * inside the blind spot: a refusal that landed during it would fall before the
   * bound and be filtered out as somebody else's.
   *
   * An instant slightly too EARLY costs nothing — the check may consider one
   * extra old notice and reject it by document name. An instant too LATE drops a
   * real refusal on the floor. When a bound can only be wrong in one direction,
   * take the harmless one.
   */
  const sentAt = new Date();
  const sent = await sendToKindle(
    { config: deps.config, toAddress: record.address, filename: got.filename, bytes: got.bytes },
    deps.mail,
  );
  if (sent.state === 'accepted') {
    const scheduled = scheduleVerification(deps, senderHandle, got.filename, subject.title, sentAt);
    return {
      state: 'delivered',
      filename: got.filename,
      sentAt: sentAt.toISOString(),
      detail:
        `"${got.filename}" is on its way to your Kindle.` +
        (scheduled
          ? ' The mail server accepted it — I have NOT confirmed it reached the device, and I will ' +
            'come back if Amazon refuses it.'
          : ' The mail server accepted it. I cannot check whether Amazon accepts it on this ' +
            'deployment, so nothing will tell you if it is refused.'),
    };
  }
  if (sent.state === 'rejected') return { state: 'failed', detail: sent.detail };
  /**
   * 🔴 UNKNOWN *AFTER* THE MAIL HAND-OFF IS TERMINAL, NOT A RETRY.
   *
   * `sendToKindle` documents this state as "It MAY have gone — do not simply
   * retry without checking, or the person may receive it twice." Returning
   * `unknown` here would do exactly that: the runner treats `unknown` as "no
   * verdict yet", defers, and the next attempt re-fetches and re-mails a book
   * that may already be on its way.
   *
   * `unknown` BEFORE the hand-off (could not read qBittorrent, could not reach
   * the bot) is safe to retry. `unknown` AFTER it is not, and the two must not
   * share a state. An uncertain single delivery beats a certain double one.
   */
  return {
    state: 'failed',
    detail:
      `${sent.detail} I have NOT tried again, because it may already have gone and you would ` +
      'get it twice. Check your Kindle, and ask me if it never turns up.',
  };
}

/**
 * How long to wait before looking for a refusal.
 *
 * Amazon's notices are minutes behind the send, not seconds — the ones in the
 * mailbox arrive 1-4 minutes after their stated send time. Twelve minutes is
 * comfortably past that without leaving somebody waiting a long time to be told
 * their book was thrown away.
 */
export const VERIFY_DELAY_MS = 12 * 60 * 1000;

/** Only what this module needs from the follow-up store. */
export interface FollowupScheduler {
  schedule(input: {
    kind: 'kindle-verify';
    senderHandle: string;
    dueAt: Date;
    reason: string;
    observed: string;
    verify: { filename: string; title: string; sentAt: string };
  }): unknown;
}

function scheduleVerification(
  deps: DeliverDeps,
  senderHandle: string,
  filename: string,
  title: string,
  sentAt: Date,
): boolean {
  if (!deps.followups) return false;
  try {
    deps.followups.schedule({
      kind: 'kindle-verify',
      senderHandle,
      dueAt: new Date(sentAt.getTime() + VERIFY_DELAY_MS),
      reason: `sent "${title}" to their Kindle`,
      observed: `the mail server accepted "${filename}" at ${sentAt.toISOString()}`,
      verify: { filename, title, sentAt: sentAt.toISOString() },
    });
    return true;
  } catch {
    /**
     * 🔴 A FAILED SCHEDULE MUST NOT LOOK LIKE A SUCCESSFUL ONE.
     *
     * The book HAS gone; losing the check is bad but undoing the send is
     * impossible. Returning false makes the outcome text say the send is
     * unchecked, which is the honest half of a bad situation.
     */
    return false;
  }
}

type Got =
  | { state: 'ok'; filename: string; bytes: Buffer }
  | { state: 'waiting'; detail: string }
  | { state: 'failed'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * IRC: ask the bot, wait for the DCC.
 *
 * ⚠️ Never attempted inside a turn. A bot may queue a request for **ten minutes
 * or more**, and a turn that blocks on that is a turn that never ends. When the
 * caller cannot block, this reports `waiting` WITHOUT sending the request, so
 * the request happens exactly once, in the follow-up, where there is time.
 */
async function fetchViaIrc(subject: EbookDeliverSubject, deps: DeliverDeps, mayBlock: boolean): Promise<Got> {
  if (!deps.irc) {
    return { state: 'failed', detail: 'the IRC source is not available on this deployment.' };
  }
  if (!subject.command || !subject.bot) {
    return { state: 'failed', detail: 'that pick did not carry an IRC command, so it cannot be fetched.' };
  }
  if (!mayBlock) {
    return {
      state: 'waiting',
      detail: `queued a request to ${subject.bot} on IRC. Transfers there take minutes.`,
    };
  }
  const r = await deps.irc.fetch(subject.command, subject.bot);
  if (r.state === 'ok') return { state: 'ok', filename: r.filename, bytes: r.bytes };
  // `failed` from the client is terminal (bot absent, never answered, truncated,
  // passive DCC). `unknown` means we could not even establish that much.
  return r.state === 'failed' ? { state: 'failed', detail: r.detail } : { state: 'unknown', detail: r.detail };
}

/** SABnzbd: poll the stored job id, then read the file off the local mount. */
async function fetchViaSab(subject: EbookDeliverSubject, deps: DeliverDeps): Promise<Got> {
  if (!subject.nzoId) {
    return {
      state: 'failed',
      detail: 'that pick did not carry a SABnzbd job id, so it cannot be fetched. Nothing was resubmitted.',
    };
  }
  const sab = deps.config.sabnzbd;
  const job = await new SabnzbdClient({
    baseUrl: sab.baseUrl,
    apiKey: sab.apiKey,
    category: sab.category,
    ...(deps.sabFetch ? { fetchImpl: deps.sabFetch } : {}),
  }).job(subject.nzoId);
  if (job.state === 'queued' || job.state === 'missing' || job.state === 'incomplete') {
    return { state: 'waiting', detail: job.state === 'queued' ? `SABnzbd still has the job (${job.status}). Nothing has been mailed.` : job.detail };
  }
  if (job.state === 'unknown') return { state: 'unknown', detail: job.detail };
  if (job.state === 'failed') return { state: 'failed', detail: `${job.detail} Nothing was sent.` };

  const book = await readContainedBook({
    storage: job.storage,
    storagePrefix: sab.storagePrefix,
    localDir: sab.localDir,
  });
  if (book.state === 'ok') return { state: 'ok', filename: book.filename, bytes: book.bytes };
  if (book.state === 'absent') return { state: 'waiting', detail: book.detail };
  if (book.state === 'rejected') return { state: 'failed', detail: `${book.detail} Nothing was sent.` };
  return { state: 'unknown', detail: book.detail };
}

/** Prowlarr/qBittorrent: is it on disk yet, and if so read it off hp. */
async function fetchViaTorrent(subject: EbookDeliverSubject, deps: DeliverDeps): Promise<Got> {
  /**
   * ⚠️ REACHABLE ONLY IF SOMEONE BREAKS AN ORDERING INVARIANT. `send_ebook`
   * resolves the hash ABOVE both the grab and the subject it builds here, so a
   * prowlarr subject always carries one. `EbookDeliverSubject` has no
   * `downloadUrl`, so a follow-up persisted with an empty hash could never
   * recover — keep the resolve above the subject construction.
   */
  if (!subject.infoHash) {
    return { state: 'failed', detail: 'that pick did not carry a torrent hash, so it cannot be fetched.' };
  }
  const status = await grabStatus({
    adminSshHost: deps.config.adminSshHost,
    qbitBaseUrl: deps.config.qbittorrent.baseUrl,
    infoHash: subject.infoHash,
    exec: deps.exec,
  });
  if (status.state === 'unknown') return { state: 'unknown', detail: status.detail };
  if (status.state === 'missing') return { state: 'failed', detail: status.detail };
  if (status.state === 'downloading') return { state: 'waiting', detail: status.detail };

  const hostPath = toHostPath(status.contentPath, deps.mounts ?? []);
  if (!hostPath) {
    return {
      state: 'failed',
      detail:
        `qBittorrent reports "${status.contentPath}", which maps to no known mount. ` +
        'That is a configuration problem, not a missing book.',
    };
  }
  const book = await resolveBookPath({ adminSshHost: deps.config.adminSshHost, hostPath, exec: deps.exec });
  if (book.state === 'none') return { state: 'failed', detail: book.detail };
  if (book.state !== 'ok') return { state: 'unknown', detail: book.detail };

  const file = await fetchFileFromHp({ adminSshHost: deps.config.adminSshHost, hostPath: book.path, exec: deps.exec });
  if (file.state === 'ok') return { state: 'ok', filename: file.name, bytes: file.bytes };
  return file.state === 'corrupt'
    ? { state: 'failed', detail: file.detail }
    : { state: 'unknown', detail: file.detail };
}
