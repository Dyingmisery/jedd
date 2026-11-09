import { resolveOfKind } from '../choices.js';
import {
  bookAlreadyRequested,
  bookCouldNotAdd,
  bookEmailed,
  bookFailureLine,
  bookRequestAdded,
  deliverEbook,
} from '../media/ebook-deliver.js';
import { grabTorrent, type MountMap } from '../media/grab.js';
import { resolveMagnet, type FetchImpl } from '../media/prowlarr.js';
import { SabnzbdClient } from '../media/sabnzbd.js';
import type { IrcEbooks } from '../media/irc-ebooks.js';
import type { MailSender } from '../media/kindle-send.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * Grab a book and send it to the person's Kindle.
 *
 * ── 🔴 THE ADDRESS IS NOT A PARAMETER, AT ANY LAYER ──────────────────────────
 *
 * The schema below takes a CHOICE NUMBER. The address is resolved from
 * `ctx.senderHandle` against the verified store, and the store only accepts a
 * value that appeared verbatim in that person's own messages. **There is no
 * path by which a model-supplied string becomes a recipient.**
 *
 * ── WHY THIS SHIPPED ONLY NOW ────────────────────────────────────────────────
 *
 * Eight modules had to work first. A tool that implies a capability it lacks is
 * the `request_media` mistake, and it would have been worse here: the user would
 * be told a book was on its way.
 */

/** Where qBittorrent's paths map to on hp. Container view → host view. */
export const DEFAULT_MOUNTS: MountMap[] = [
  // ⚠️ A real path on a real machine, so it is configuration. Empty rather than
  // guessed: a wrong host prefix produces a file-not-found, not a wrong file.
  { containerPrefix: '/downloads', hostPrefix: process.env.EBOOK_HOST_DOWNLOAD_PREFIX ?? '' },
];

export interface SendEbookDeps {
  send: MailSender;
  mounts?: MountMap[];
  /**
   * 🔴 LIVE-TEST SAFETY, STRUCTURAL RATHER THAN REMEMBERED.
   *
   * When set, the tool refuses to send to anyone but this handle. A first live
   * test that emails a real book to a real third party is not a test — it is an
   * outward-facing action on someone who did not ask for it.
   *
   * It is a constructor argument rather than a config flag so the restricted
   * build is a DIFFERENT OBJECT, not the same object in a different mood.
   */
  onlySendTo?: string;
  /** Test seam for resolving a magnet from a Prowlarr download link. */
  fetchImpl?: FetchImpl;
  /** Test seam for the SABnzbd API. Unset in production. */
  sabFetch?: FetchImpl;
  /** The IRC source, when this deployment has one. */
  irc?: IrcEbooks;
}

export function makeSendEbook(deps: SendEbookDeps): Tool {
  // The resolve seam. Production uses the real `fetch`; tests inject.
  const fetchImpl: FetchImpl | undefined = deps.fetchImpl;
  return {
    name: 'send_ebook',
    description:
      'Grab the book the person CHOSE from the numbered list search_ebook returned and send it to ' +
      'their Kindle. Pass the number they picked. Do not call this until they have actually said ' +
      'which one — a book search returns different works, not different copies of one book. You do ' +
      'not supply an address — theirs is already stored, and if it is not, ask them for it and save ' +
      'it first.',
    minRole: 'guest',
    writes: true,
    consumesChoiceKind: 'ebook-release',
    /**
     * 🔴 `choice` IS REQUIRED, AND ITS ABSENCE IS A REFUSAL — NOT A DEFAULT.
     * See the same note in `add-audiobook.ts`: `search_ebook` asks now, and a
     * default of 1 would make that ask advisory, since the model could grab the
     * top-ranked work without anybody ever having answered.
     */
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'number',
          description: 'The number THEY picked from the list. Required — never guess it, never assume 1.',
        },
      },
      required: ['choice'],
    },
    async run(args, ctx: ToolContext) {
      if (args['choice'] === undefined) {
        return fail(
          'NO PICK — nothing was grabbed or sent. A book search returns different works, so there ' +
            'is no "best" one to fall back on. Show them the numbered list and ask which book they ' +
            'meant.',
        );
      }
      const n = Number(args['choice']);
      if (!Number.isFinite(n)) return fail('That is not an option number.');
      if (ctx.config.readOnly) return fail('Writes are disabled, so nothing was grabbed or sent.');
      if (!ctx.choices) return fail('No option store is available.');
      if (!ctx.kindle) return fail('No address store is available.');

      // ── who it goes to, decided before anything is done ──────────────────
      const record = ctx.kindle.get(ctx.senderHandle);
      if (!record) {
        return fail(
          'NO ADDRESS — nothing was grabbed. Ask them for their @kindle.com address and save it ' +
            'first; do not guess one.',
        );
      }
      if (deps.onlySendTo && ctx.senderHandle !== deps.onlySendTo) {
        return fail(
          `RESTRICTED — this build only sends to ${deps.onlySendTo}. Nothing was grabbed or sent.`,
        );
      }

      // ── which book, and FROM WHERE ───────────────────────────────────────
      const picked = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'ebook-release');
      if (!picked.ok) return fail(`${picked.reason.toUpperCase()} — ${picked.detail}`);
      const option = picked.option;

      /**
       * ── 🔴 A `.mobi` PICK IS REFUSED AND RE-ASKED. IT IS NOT SWAPPED. ──────
       *
       * This code used to silently substitute a different option — *"the top
       * release was a .mobi, so I took the best Kindle-compatible one instead"*
       * — and the comment justifying that said so explicitly: *"Nobody is shown
       * a list of releases any more, so a `choice` number cannot mean 'I looked
       * at the options and I want the .mobi'. It can only mean 'not that one'."*
       *
       * **That premise is now false.** `search_ebook` returns a numbered list of
       * what are usually DIFFERENT WORKS, and the number that arrives here is
       * the one a person read and picked. Swapping it for another row is no
       * longer "the same book in a better format" — measured live, option 1 for
       * *"The Hobbit"* was a study guide and option 3 was the novel, so the swap
       * would take a book NOBODY asked for and report it as SENT.
       *
       * ⚠️ The swap was correct under auto-pick and it becomes correct again the
       * moment the WORK is pinned before the releases are ranked, because every
       * option in the list is then genuinely the same book. Restore it there —
       * not before.
       */
      if (isMobi(String(option.value['title'] ?? option.label))) {
        /**
         * ⚠️ ANY FORMAT AMAZON ACCEPTS, not `.epub` or nothing. `ebook-validate.ts`
         * passes `epub`, `azw3` and `pdf`, so the alternatives OFFERED are all
         * three — naming only EPUBs would hide a book that would have arrived
         * perfectly well.
         */
        const usable = picked.choice.options.filter(
          (o) => o.n !== option.n && /\.(epub|azw3|pdf)\b/i.test(String(o.value['title'] ?? o.label)),
        );
        return fail(
          `REFUSED — option ${option.n} is a .mobi. Amazon stopped accepting that format in 2022 ` +
            'and rejects it SILENTLY, so it would look sent and never arrive. Nothing was fetched ' +
            'and NOTHING WAS SUBSTITUTED — the other options may be different books, so do not ' +
            'quietly send one of them.' +
            (usable.length
              ? ` Tell them that one will not work and ask whether one of these is the same book: ` +
                `${usable.map((o) => `${o.n}. ${o.label}`).join('; ')}.`
              : ' Nothing else that was found is a format Amazon accepts either — say so and offer ' +
                'to search again.'),
        );
      }

      const value = option.value;
      const title = String(value['title'] ?? option.label);

      /**
       * 🔴 ABSENT `source` MEANS PROWLARR, EXPLICITLY.
       *
       * `choices.jsonl` is durable and every option written before IRC existed
       * has no `source` key at all. A pending list that survives a restart would
       * otherwise arrive here with `undefined` and match neither branch — the
       * first pick after this deploy would break. Defaulting is a MIGRATION,
       * not a convenience, which is why it is spelled out rather than relying on
       * a falsy check somewhere below.
       */
      const source = value['source'] === 'irc' ? 'irc' : 'prowlarr';
      if (source !== 'irc' && value['protocol'] === 'usenet') {
        const downloadUrl = typeof value['downloadUrl'] === 'string' ? value['downloadUrl'] : '';
        if (!downloadUrl) {
          return fail('COULD NOT FETCH — that Usenet release has no NZB link. Nothing was submitted.');
        }
        return submitUsenet(ctx, deps, title, downloadUrl);
      }

      /**
       * ⚠️ THE SECOND `.mobi` GUARD THAT USED TO SIT HERE IS GONE, NOT MOVED BY
       * ACCIDENT. It tested exactly the expression the refusal above tests, on
       * the same `option`, and the swap between them was the only thing that
       * could change the answer. With the swap removed it could never fire, and
       * a dead guard reads as protection while providing none.
       * `ebook-validate.ts` still checks the BYTES on the way out, which is the
       * check that never depended on the filename.
       */

      // ── start the fetch ──────────────────────────────────────────────────
      // 🔴 Resolved BEFORE the grab and reused for the subject below, because
      // `deliverEbook` finds the file by hash. Resolving twice, or resolving
      // only for the grab, would leave the delivery looking for ''.
      let infoHash = String(value['infoHash'] ?? '');
      /**
       * ⚠️ A LOCAL, NOT A WRITE BACK INTO `value`.
       *
       * `value` is `picked.option.value` — the object the ChoiceStore still
       * holds in memory. Writing the resolved magnet into it mutated live state
       * that is never re-appended to `choices.jsonl`, so memory and the file
       * diverged, and the stale pair outlived the turn for the choice TTL.
       * Nothing needs it outside this function.
       */
      let magnetUri = typeof value['magnetUri'] === 'string' ? value['magnetUri'] : undefined;
      if (source === 'prowlarr' && !infoHash) {
        const downloadUrl = typeof value['downloadUrl'] === 'string' ? value['downloadUrl'] : '';
        const resolved = downloadUrl
          ? await resolveMagnet(downloadUrl, fetchImpl)
          : ({ state: 'unknown', detail: 'that release carries neither an infoHash nor a download link.' } as const);
        if (resolved.state === 'unknown') {
          return fail(
            `COULD NOT FETCH — ${resolved.detail} Nothing was sent. Say that this particular copy ` +
              'could not be started, NOT that the book is unavailable.',
          );
        }
        infoHash = resolved.infoHash;
        magnetUri = resolved.magnetUri;
      }
      if (source === 'prowlarr') {
        const grab = await grabTorrent({
          adminSshHost: ctx.config.adminSshHost,
          qbitBaseUrl: ctx.config.qbittorrent.baseUrl,
          infoHash,
          ...(magnetUri ? { magnetUri } : {}),
          title,
          category: 'ebooks',
          exec: ctx.exec,
        });
        if (grab.state === 'failed') return fail(`FAILED — ${grab.detail}`);
        if (grab.state === 'unknown') return fail(`UNKNOWN — ${grab.detail}`);
      }

      const subject = {
        source,
        title,
        ...(source === 'prowlarr'
          ? { infoHash }
          : { command: String(value['command'] ?? ''), bot: String(value['bot'] ?? '') }),
      } as const;

      /**
       * One attempt now, in case the torrent is already on disk — the fast path
       * that was there before and is worth keeping. IRC never blocks a turn:
       * a bot can queue a request for ten minutes or more.
       */
      const attempt = await deliverEbook(
        subject,
        ctx.senderHandle,
        {
          config: ctx.config,
          kindle: ctx.kindle,
          mail: deps.send,
          ...(ctx.exec ? { exec: ctx.exec } : {}),
          ...(deps.irc ? { irc: deps.irc } : {}),
          mounts: deps.mounts ?? DEFAULT_MOUNTS,
          // So a send that completes INSIDE the turn is checked too. Omitting it
          // here would leave the fast path — the one that fires when the torrent
          // is already on disk — as the single unverified way to send a book.
          ...(ctx.followups ? { followups: ctx.followups } : {}),
          ...(deps.onlySendTo ? { onlySendTo: deps.onlySendTo } : {}),
        },
        { mayBlock: false },
      );

      if (attempt.state === 'delivered') {
        return { ...ok(`SENT — ${attempt.detail}`), verbatimReply: bookEmailed(title) };
      }
      if (attempt.state === 'failed') {
        return { ...fail(`FAILED — ${attempt.detail}`), verbatimReply: bookFailureLine(title, attempt.detail) };
      }

      /**
       * 🔴 NOT HERE YET — AND THIS IS WHERE THE OLD BUG LIVED.
       *
       * This branch used to return *"DOWNLOADING — ... you will send it once it
       * lands"* and schedule NOTHING. No code path anywhere ever delivered the
       * book or told the person otherwise. That is the Peppa Pig defect in the
       * ebook flow: the grab succeeding is not the outcome, the person learning
       * what happened is.
       *
       * A follow-up is scheduled HERE, and the wording below is contingent on it
       * actually being scheduled — if there is no store, the tool says plainly
       * that it cannot come back, rather than promising on behalf of a mechanism
       * it does not have.
       */
      if (!ctx.followups) {
        return ok(
          `STARTED — ${attempt.detail} I have NOT sent anything, and I cannot check back ` +
            'on my own here. Tell them to ask again in a few minutes.',
        );
      }

      const already = ctx.followups.pendingEbook(ctx.senderHandle, title);
      if (!already) {
        ctx.followups.schedule({
          kind: 'ebook-deliver',
          senderHandle: ctx.senderHandle,
          // Due immediately: the runner's next tick starts the real work. For
          // IRC that tick is where the request is actually sent.
          dueAt: new Date(),
          reason: `started fetching "${title}" for them`,
          observed: attempt.detail,
          ebook: subject,
        });
      }

      return {
        ...ok(
          `STARTED — ${attempt.detail} NOTHING HAS BEEN SENT YET. Tell them it is on the ` +
            'way and that you will message them when it actually lands — do not say it has been sent.',
        ),
        verbatimReply: bookRequestAdded(title),
      };
    },
  };
}

/**
 * Queue one NZB and record its job id. Mail happens later, from the follow-up,
 * so this turn cannot also send the file.
 */
async function submitUsenet(
  ctx: ToolContext,
  deps: SendEbookDeps,
  title: string,
  downloadUrl: string,
): Promise<ToolResult> {
  const sab = ctx.config.sabnzbd;
  if (!sab.baseUrl || !sab.apiKey) {
    return fail('SABnzbd is not configured (SABNZBD_URL and SABNZBD_API_KEY). Nothing was submitted.');
  }
  if (!sab.storagePrefix || !sab.localDir) {
    return fail(
      'SABnzbd paths are not configured (SABNZBD_STORAGE_PREFIX and SABNZBD_LOCAL_DIR). Nothing was submitted.',
    );
  }
  if (!ctx.followups) {
    return fail(
      'There is nowhere to record the SABnzbd job, so it was NOT submitted. Nothing was sent.',
    );
  }
  const pending = ctx.followups.pendingEbook(ctx.senderHandle, title);
  if (pending) {
    return {
      ...ok(
        `STARTED — "${title}" is already being fetched. NOTHING HAS BEEN SENT YET. Do not start a second copy. ` +
          'Tell them you will message them when the mail server has actually accepted the file — do not say it ' +
          'has been sent, and do not say it is on their Kindle.',
      ),
      verbatimReply: bookAlreadyRequested(title),
    };
  }
  const added = await new SabnzbdClient({
    baseUrl: sab.baseUrl,
    apiKey: sab.apiKey,
    category: sab.category,
    ...(deps.sabFetch ? { fetchImpl: deps.sabFetch } : {}),
  }).addUrl(downloadUrl);
  if (added.state !== 'accepted') {
    return { ...fail(`FAILED — ${added.detail} Nothing was sent.`), verbatimReply: bookCouldNotAdd(title) };
  }
  ctx.followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: ctx.senderHandle,
    dueAt: new Date(),
    reason: `started fetching "${title}" from Usenet for them`,
    observed: `SABnzbd accepted the NZB as job ${added.nzoId}. Nothing has been mailed.`,
    ebook: { source: 'sab', title, nzoId: added.nzoId },
  });
  return {
    ...ok(
      `STARTED — SABnzbd accepted "${title}" in category ${sab.category}. NOTHING HAS BEEN SENT YET. ` +
        'The download has not finished. Tell them it is queued and that you will message them when the ' +
        'mail server has actually accepted the file — do not say it has been sent, and do not say it is on their Kindle.',
    ),
    verbatimReply: bookRequestAdded(title),
  };
}

/** Amazon has rejected `.mobi` since 2022, and does it silently. */
function isMobi(title: string): boolean {
  return /\.mobi\b/i.test(title);
}
