import { byScore, describeSwarm, swarmHealth, swarmRank } from '../media/pick-release.js';
import {
  CATEGORY,
  GRAPHIC_AUDIO,
  isValidInfoHash,
  ProwlarrClient,
  rankAudiobooks,
  resolveMagnet,
  rankReleases,
  type FetchImpl,
  type Release,
  type SearchResult,
} from '../media/prowlarr.js';
import type { IrcEbooks, IrcSearchOutcome } from '../media/irc-ebooks.js';
import type { IrcResult } from '../media/irc-protocol.js';
import {
  matchWork,
  pinWork,
  relevantWorks,
  searchTerms,
  significantTitleTokens,
  tokens,
  WORK_MATCH,
  type SearchTerm,
  type Work,
} from '../media/book-work.js';
import { describeWork, OpenLibraryClient, type OpenLibraryOptions } from '../media/openlibrary.js';
import { resolveOfKind } from '../choices.js';
import { bookNoEpub } from '../media/ebook-deliver.js';
import { isEpubClaim } from '../media/ebook-validate.js';
import { mayRequestKindle } from '../permissions.js';
import { fail, ok, type Tool } from './types.js';

/** Bounded: each attempt is a request against a client that warns about hammering. */
const MAX_RESOLVE_ATTEMPTS = 3;

/**
 * The PRODUCERS for `add_audiobook` and `send_ebook`.
 *
 * ── 🔴 THE REGRESSION THIS CLOSES, AND WHY IT WAS INVISIBLE ─────────────────
 *
 * Jeff, live: *"Can you get the ready player one audiobook?"* Jedd: *"I've got a
 * tool to start an audiobook download, but it needs a pick from an audiobook
 * search — and I don't have an audiobook search tool."*
 *
 * `add_audiobook` was registered, booted, and sat in the live tool line, and it
 * was **uncallable**: it resolves a numbered pick and nothing produced one.
 * `send_ebook` was in the identical state — and `send_ebook` had been *verified
 * live end to end, a real book reached a real Kindle*, through a script that
 * constructed it directly. **"It works" and "it can be reached" were both true,
 * of different objects.**
 *
 * `ProwlarrClient` and `rankReleases` were already written, complete, with the
 * three-state discipline — and had **no caller anywhere in the repo**. This file
 * is the caller. See `assertChoiceProducersExist` in `index.ts` for the
 * invariant that now makes this class of gap refuse to boot.
 *
 * ── ONE FACTORY, TWO TOOLS ──────────────────────────────────────────────────
 *
 * Audiobooks and ebooks differ by a Prowlarr category id and which tool takes
 * the pick afterwards. They are two named tools rather than one with an enum
 * **because the model must route to a different consumer** — `add_audiobook`
 * versus `send_ebook` — and a name that says which medium it searched is the
 * thing that makes that obvious.
 */
/**
 * ── 🔴 IRC IS A SECOND SOURCE INSIDE THIS TOOL, NOT A SECOND TOOL ───────────
 *
 * Two reasons, and the structural one is the stronger:
 *
 * 1. **The registry punishes the split.** `assertChoiceProducersExist` and
 *    `assertNamedProducersExist` (see `index.ts`) throw at boot if a consumer's
 *    choice kind has no producer, or if a description names a tool that is not
 *    registered. A separate `search_ebook_irc` would either need its own
 *    consumer or would re-declare `presentsChoiceKinds: ['release']` — the same
 *    producer twice under a different name, with the model now forced to choose
 *    between two tools that do the same job.
 * 2. Tool selection was measured at **0/5 at production registry size** on
 *    2026-08-26. Adding names makes that worse.
 *
 * So both sources return ONE numbered list, and the pick carries its own
 * provenance in `value.source`. The model never decides which fetcher runs —
 * `send_ebook` switches on the stored value, in code.
 */
/**
 * Does what they SAID name this book — every significant word of it?
 *
 * The gate on auto-pinning a lone catalogue survivor. Deliberately containment
 * rather than a score: a threshold invites tuning, and the question here is not
 * "how close is this" but "did they say it".
 */
function namesTheWork(query: string, work: Work): boolean {
  const asked = new Set(tokens(query));
  const title = significantTitleTokens(work.title);
  return title.length > 0 && title.every((t) => asked.has(t));
}

function makeReleaseSearch(
  medium: 'audiobook' | 'ebook',
  fetchImpl?: FetchImpl,
  irc?: IrcEbooks,
  openLibrary?: OpenLibraryOptions,
): Tool {
  const isAudio = medium === 'audiobook';
  const consumer = isAudio ? 'add_audiobook' : 'send_ebook';
  return {
    name: isAudio ? 'search_audiobook' : 'search_ebook',
    /**
     * ⚠️ ONLY THE AUDIOBOOK HALF NEEDS PROWLARR. `search_ebook` has a SECOND
     * source — IRC — so gating it on Prowlarr would remove a tool that still
     * works for anyone running IRC_EBOOKS and no indexer. Same factory, and
     * deliberately not the same dependency.
     */
    needsServices: isAudio ? ['prowlarr'] : [],
    description: isAudio
      ? 'Search for an AUDIOBOOK — a book to LISTEN to. It works out WHICH BOOK they mean first, ' +
        'then CHOOSES the best release itself; do NOT list releases and do NOT ask which torrent ' +
        `they want. Then call ${consumer} to start it. If it comes back asking WHICH BOOK, show ` +
        'them those books and call this again with the same query and their number as `choice`. Do ' +
        'NOT say anything is downloading yet. Set graphic_audio true ONLY if they explicitly asked ' +
        'for a GraphicAudio dramatisation.'
      : 'Search for an EBOOK — a book to READ, delivered to their Kindle. It works out WHICH BOOK ' +
        'they mean first, then CHOOSES the best release itself; do NOT list releases and do NOT ask ' +
        `which torrent they want. Then call ${consumer}. If it comes back asking WHICH BOOK, show ` +
        'them those books and call this again with the same query and their number as `choice`. Do ' +
        'NOT say anything is being sent yet. A Usenet release has no seeder count; that is normal ' +
        'and is NOT a dead swarm — do not tell them it is unseeded. Use search_audiobook instead ' +
        'if they want to LISTEN.',
    minRole: 'guest',
    /**
     * ⚠️ A READ. It searches indexers and stores a list; nothing is grabbed and
     * nothing is sent until the consumer runs. Marking it a write would remove
     * the producer in read-only mode and take the whole flow down with it —
     * which is the same shape as the bug this file exists to fix.
     */
    writes: false,
    /**
     * 🔴 TWO KINDS, NOT ONE, AND THE SPLIT IS A SAFETY GUARD.
     *
     * Both media used to present `release`. `add_audiobook` reads an `infoHash`
     * off whatever it resolves and hands it to qBittorrent under the AUDIOBOOK
     * category — with no shape check of any kind — so a pending EBOOK list was
     * fully resolvable by it, and a `.epub` landed in `/downloads/audiobooks`
     * where the host cron feeds it to Audiobookshelf. It reported STARTED.
     *
     * `sonarr-release` was already split from `release` for exactly this reason
     * and said so in `fill-gaps.ts`; this is the same argument, one level in.
     */
    /**
     * 🔴 TWO KINDS OUT, BECAUSE THERE ARE TWO QUESTIONS AND ONLY ONE OF THEM IS
     * THE USER'S.
     *
     * `book-work` is *which book* — presented only when the catalogue cannot
     * settle it, and answered by a person. The release kind is *which copy*,
     * stored but never asked about: that one is decided here, on swarm health,
     * among releases that are copies of the pinned work.
     */
    presentsChoiceKinds: [isAudio ? 'audiobook-release' : 'ebook-release', 'book-work'],
    /**
     * 🔴 AND IT CONSUMES THE ONE IT PRODUCES. This tool is RE-ENTRANT: the first
     * call may hand back candidate works, and the answer comes back to this same
     * tool rather than to a second one.
     *
     * That is deliberate. The alternative — a `find_book` tool that presents
     * works and hands them on — makes the ebook flow THREE tool calls deep
     * (find → search → send) and adds a name to a registry where tool selection
     * was measured at 0/5 at production size on 2026-08-26. Re-entering one tool
     * keeps the flow two calls deep, exactly as it is today.
     */
    consumesChoiceKind: 'book-work',
    parameters: {
      type: 'object',
      properties: {
        /**
         * 🔴 THE SERIES NAME IS NAMED HERE BECAUSE DROPPING IT IS THE MEASURED
         * DEFECT — see the block comment above the series test in
         * `book-work-pinning.test.ts` for the turn this comes from.
         *
         * The old text asked for "Title and author if known" and never mentioned
         * a series, so a request that named one arrived here with it removed and
         * searched for a different, real book. Every DCC release on the index is
         * named `<Title> (Dungeon Crawler Carl NN) by Matt Dinniman`, which makes
         * the series the single most identifying token available — and the
         * example is a series example now, because an example is the part of a
         * description a model actually copies.
         */
        query: {
          type: 'string',
          description:
            'What they said the book IS: title, plus the SERIES name and the author whenever they ' +
            'mentioned either — e.g. "Project Hail Mary Andy Weir", or "The Dungeon Anarchists ' +
            'Cookbook Dungeon Crawler Carl". 🔴 If they named a series, KEEP IT: series names are ' +
            'how these releases are titled, and a title alone can be a different real book. Never ' +
            'drop a word they gave you to tidy the query. Do NOT include the word ' +
            `"${isAudio ? 'audiobook' : 'book'}".`,
        },
        choice: {
          type: 'number',
          description:
            'ONLY when this tool has just asked WHICH BOOK they meant and they answered: the number ' +
            'they picked. Leave it out on a first search. It is never a release number.',
        },
        ...(isAudio
          ? {
              graphic_audio: {
                type: 'boolean',
                description:
                  'True ONLY if they explicitly asked for a GraphicAudio dramatisation. If they said ' +
                  'they did not want one, or did not mention it, leave it false.',
              },
            }
          : {}),
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return fail(`No search terms. Ask which ${medium} they want.`);
      if (!isAudio && !mayRequestKindle(ctx.senderHandle, ctx.config)) {
        return fail('REFUSED — ebook search is not enabled for this sender. Nothing was searched.');
      }

      const hasIrc = !isAudio && !!irc;
      if (!ctx.config.prowlarr.apiKey && !hasIrc) {
        return fail(`Prowlarr is not configured here, so I cannot search. This is not "no ${medium}s exist".`);
      }
      /**
       * 🔴 NO STORE, NO LIST. Unlike `catalogue_search`, this flow has no other
       * route: `${consumer}` takes ONLY a pick. Presenting numbered options that
       * nothing can resolve would offer a flow that cannot complete.
       */
      if (!ctx.choices) {
        return fail(
          'There is nowhere to record a numbered list, so a pick could not be resolved afterwards. ' +
            'Nothing was searched for them to choose from.',
        );
      }

      /**
       * ═══ STAGE ONE: WHICH BOOK ═══════════════════════════════════════════
       *
       * 🔴 THE WORK IS SETTLED BEFORE A SINGLE RELEASE IS RANKED, which is the
       * whole shape of the fix. See `book-work.ts` for the measurement and for
       * the honest limit on what pinning can buy on a filename index.
       *
       * ⚠️ RESOLVING THE PICK HAPPENS BEFORE THE CLEAR, AND THE ORDER IS LOAD
       * BEARING. The clear-on-start rule below exists so a stale list cannot be
       * picked from — but on the re-entrant call the pending list IS the one we
       * are being answered about. Clearing first would destroy the answer we
       * were just given, on every ambiguous book, every time.
       */
      let work: Work | undefined;
      const pick = args['choice'];
      if (pick !== undefined) {
        const n = Number(pick);
        if (!Number.isFinite(n)) return fail('That is not an option number.');
        const chosen = resolveOfKind(ctx.choices, ctx.senderHandle, n, 'book-work');
        if (!chosen.ok) {
          return fail(
            `${chosen.reason.toUpperCase()} — ${chosen.detail} Nothing was searched. If they were ` +
              'answering a list of BOOKS, search again by name; a release number does not belong here.',
          );
        }
        work = chosen.option.value['work'] as Work;
      }

      /**
       * 🔴 THE PENDING LIST DIES WHEN A NEW SEARCH **STARTS**, NOT WHEN ONE
       * SUCCEEDS. Same note as `fill-gaps.ts`, and the reason survived the
       * consumer losing its default:
       *
       * *search "Dune" (stored) → search "The Hobbit" (Prowlarr 500, UNKNOWN) →
       * "yeah, 2"* now resolves **2 from the DUNE list** and reports STARTED
       * naming a book nobody is talking about. The number is no longer optional,
       * but a number is not self-describing either — it means whatever list is
       * lying around.
       *
       * ⚠️ Clearing FIRST rather than in each early return is the point: the
       * branch someone forgets is the one that ships.
       */
      ctx.choices.clear(ctx.senderHandle);

      /**
       * 🔴 THE CATALOGUE IS AN IMPROVEMENT, NOT A DEPENDENCY.
       *
       * Every failure here degrades to the behaviour of 2.0.1 — present the
       * releases and ask which book — rather than taking the flow down. An
       * `unknown` from the catalogue is a failure to LOOK and must never become
       * "there is no such book": the fallback is the same either way, but the
       * wording the model is handed is not, and one of them is a lie.
       */
      let workNote = '';
      if (!work) {
        const found = await new OpenLibraryClient({
          baseUrl: ctx.config.openLibrary.baseUrl,
          ...openLibrary,
        }).works(query);
        if (found.state === 'works') {
          work = pinWork(query, found.works);
          /**
           * 🔴 CANDIDATES THAT SHARE NOTHING WITH THE REQUEST ARE NOT AN ANSWER.
           *
           * Live, 2026-08-27, *"that hobbit book"* came back with `Final
           * Planning Book` and `American Film` among the five. See
           * `relevantWorks`: presenting those asks somebody to choose which of
           * five wrong books they meant. When nothing plausible survives, the
           * catalogue genuinely could not settle it, and saying so is the
           * honest report — it takes the same fallback as an unreachable one.
           */
          const plausible = relevantWorks(query, found.works).slice(0, 5);
          if (!work && plausible.length === 0) {
            workNote = `the book catalogue returned nothing that looks like "${query}"`;
          } else if (!work && plausible.length === 1 && namesTheWork(query, plausible[0]!)) {
            /**
             * 🔴 ONE SURVIVOR THE QUERY ACTUALLY NAMES IS AN ANSWER, NOT A
             * QUESTION. Measured 2026-09-04.
             *
             * `pinWork` needs the query to BE the title; a query that names the
             * SERIES and the book never is one. So Jeff's *"the 2nd dungeon
             * crawler Carl book, 'The anarchists cookbook'"* fell through to the
             * ask, and the tool asked *"WHICH BOOK — this matches more than one
             * book"* above a list containing exactly one. The question is false
             * as written and costs a round trip to answer nothing.
             *
             * ⚠️ THE `namesTheWork` GATE IS THE WHOLE SAFETY OF THIS BRANCH, AND
             * THE OBVIOUS VERSION WITHOUT IT WAS NOT SAFE.
             *
             * `relevantWorks` admits a work on ONE shared token, author tokens
             * included — it decides what is worth putting in a list a person
             * READS, which is a display-grade judgement. This branch turns it
             * into a purchase-grade one: the CHOSE reply below ends *"Call
             * add_audiobook now with choice 1"*, and that consumer grabs
             * immediately, so the settle and the download land in the SAME turn.
             * The person does not get to see the book's name first. The ask this
             * replaces was the last checkpoint, so what replaces it has to be
             * stronger than one coincidental word — a lone survivor sharing only
             * `cookbook` must still ask, and does.
             *
             * Measured over 34 queries — the 16 real ones in the audit log plus
             * 18 written to break it — AS SHIPPED, with the gate on:
             *
             *     pinWork already settled it   16
             *     AUTO-PIN here                 2   both correct
             *     one survivor, GATED to ask    1
             *     two or more, asks            12
             *     no candidates at all          3
             *
             * ⚠️ Ungated it would have fired 4 times, also all correct. The gate
             * costs two of those a round trip and buys the guarantee that this
             * branch cannot settle a book nobody named. That trade is deliberate:
             * the failure it prevents ends in a download.
             */
            work = plausible[0];
          } else if (!work) {
            /**
             * 🔴 THE ONE QUESTION WORTH ASKING, AND IT IS ABOUT BOOKS.
             *
             * Not a list of torrent filenames — a list of WORKS, with authors
             * and years, which is a question a person can actually answer. This
             * is the same shape `catalogue_search` already uses for a film and a
             * show that share a name, and Jeff has said that question is right.
             */
            ctx.choices.present({
              senderHandle: ctx.senderHandle,
              subject: query,
              kind: 'book-work',
              options: plausible.map((w, i) => ({
                n: i + 1,
                label: describeWork(w),
                value: { work: w as unknown as Record<string, unknown> },
              })),
            });
            /**
             * ⚠️ THE ONE-CANDIDATE WORDING IS NOT COSMETIC. This branch can still
             * be reached with a single option — when the survivor is one the
             * query does not actually name — and "matches more than one book"
             * above a list of one is simply false. A question that misdescribes
             * itself teaches the reader to skim the next one.
             */
            const head =
              plausible.length === 1
                ? `WHICH BOOK — the book catalogue is not sure "${query}" is this one, and nothing ` +
                  'has been searched for yet:'
                : `WHICH BOOK — "${query}" matches more than one book and nothing has been searched ` +
                  'for yet:';
            return ok(
              `${head}\n${plausible.map((w, i) => `  ${i + 1}. ${describeWork(w)}`).join('\n')}\n` +
                'Ask which one they meant. When they answer, call this same tool again with the same ' +
                'query and their number as `choice` — it will then choose the best release itself. ' +
                'If NONE of these is the book they want, say so plainly and ask for the author, then ' +
                'search again with the title and author together — do not talk them into one of ' +
                'these. Do NOT ask about torrents; that part is not their decision.',
            );
          }
        } else {
          // 'none' and 'unknown' both land here and are REPORTED differently by
          // the detail they carry. Neither is "no such book".
          workNote = found.detail;
        }
      }

      /**
       * 🔴 BOTH SOURCES ARE QUERIED BEFORE ANY "NOTHING FOUND" IS REPORTED.
       *
       * An earlier version of this merge returned Prowlarr's `none` immediately
       * and only then asked IRC — which would have answered *"no books"* for
       * exactly the case this feature exists to serve. Measured 2026-08-26:
       * Prowlarr 7 results for a title where IRC had 27. **A source that was
       * never asked cannot be evidence of absence.**
       */
      /**
       * ⚠️ THE TWO SOURCES RUN CONCURRENTLY, NOT ONE AFTER THE OTHER.
       *
       * Awaiting IRC first made every ebook search pay IRC's latency before
       * Prowlarr was even asked — up to the connect timeout plus the search
       * timeout, inside a guest-facing turn, even when Prowlarr would have
       * answered in milliseconds. Same reasoning as never blocking a turn on a
       * DCC transfer, with only the number changed.
       */
      /**
       * 🔴 ONCE A WORK IS PINNED, THE INDEXERS ARE ASKED ABOUT **THAT BOOK** AND
       * NOT ABOUT WHAT THE PERSON TYPED — FOUND BY RUNNING IT, 2026-08-27.
       *
       * *"Mistborn Brandon Sanderson"* is a SERIES name, so the catalogue could
       * not pin it and asked which book; the answer was *The Final Empire*. The
       * search then still ran on the original phrasing and came back with
       * `Mistborn Series 1-6`, `Mistborn Trilogy`, `Mistborn Complete Edition` —
       * every one of them correctly refused as a bundle, so the flow reported
       * NOT THE BOOK about a book that is plainly there. Measured, same minute:
       *
       *     "Mistborn Brandon Sanderson"       →  bundles only, 162 seeders top
       *     "The Final Empire Brandon Sanderson" →  The Final Empire by Brandon
       *                                             Sanderson EPUB, 30 seeders
       *
       * Scoring releases from a search that was never about the pinned work is
       * an identity filter applied to the wrong population, so the searches that
       * run are about the pinned work.
       *
       * 🪦 This used to end *"so the ONE search it gets is the one about the
       * right book"*. The measurement above is unchanged and still the reason
       * the term is built from the WORK; what died is the "one" — a single form
       * of a single term turned out to be how a book that is plainly there gets
       * reported as absent. See the query ladder below for what replaced it and
       * for why it is still bounded.
       *
       * ⚠️ Where the query already named the book — the measured Hobbit, Dune and
       * Project Hail Mary cases — the canonical term is the same string in a
       * different order, so nothing changes for them.
       */
      /**
       * ═══ THE QUERY LADDER ═════════════════════════════════════════════════
       *
       * 🔴 ONE QUERY FORM WAS ONE CHANCE, AND A MISS CAME BACK AS AN ABSENCE.
       *
       * Jedd, live, 2026-09-04: *"Found the right book — The Dungeon Anarchist's
       * Cookbook by Matt Dinniman — but Prowlarr still has no audiobook release
       * for it. Want me to try it as an ebook instead?"* The release was on
       * 1337x at 14 seeders the whole time. Worse than a plain miss: it is
       * stated as settled fact AND offered a fallback, which retires the
       * question — Jeff would reasonably conclude the audiobook does not exist.
       *
       * See `searchTerms` in `book-work.ts` for the measured form sensitivity.
       * The rungs are ways of asking for THE SAME BOOK, most specific first, and
       * rung one is exactly the term this code sent before — so **a search that
       * works today still costs exactly one request**, and only a search that
       * would otherwise have reported a false absence pays for the rest.
       *
       * ⚠️ "IT WORKED" IS NOT "PROWLARR RETURNED ROWS". The measured failure
       * returned three rows, none of them an audiobook of that book. So the
       * ladder climbs on ZERO USABLE CANDIDATES — after the category, the
       * GraphicAudio preference, the dead-swarm filter and the identity filter —
       * because each of those zeros is one the next rung might not have.
       *
       * ⚠️ IT DOES NOT CLIMB PAST AN `unknown`. An indexer that could not be
       * reached is a failure to LOOK, not a zero; asking a failing service two
       * more questions answers nothing and walks straight into the per-indexer
       * backoff its own client warns about. That branch reports UNKNOWN exactly
       * as it did before.
       */
      const rungs = searchTerms(query, work);
      const wantsGraphic = args['graphic_audio'] === true;
      const client = ctx.config.prowlarr.apiKey
        ? new ProwlarrClient({ ...ctx.config.prowlarr, fetchImpl })
        : undefined;

      /**
       * ⚠️ IRC IS ASKED ONCE, CONCURRENTLY WITH THE FIRST RUNG, ON THE FIRST
       * RUNG'S TERM. It is a different index with different matching — `@search`
       * across filenames a bot is holding — while the ladder exists for how
       * Prowlarr tokenises a title. Walking it against IRC as well would
       * multiply a connect-plus-search latency that already dominates this tool,
       * inside a guest-facing turn.
       */
      const ircPromise: Promise<IrcSearchOutcome> = hasIrc
        ? irc!.search(rungs[0]!.term)
        : Promise.resolve({ state: 'none' as const, detail: 'IRC is not enabled here.' });

      const attempts: Attempt[] = [];
      let ircSettled: IrcSearchOutcome | undefined;
      for (const rung of rungs) {
        /**
         * 🔴 A RUNG THAT WAS NEVER SENT IS NOT A RUNG THAT FOUND NOTHING.
         *
         * With no Prowlarr configured — a real deployment, since `search_ebook`
         * runs on IRC alone — the loop used to synthesise a `none` per rung and
         * the reply then listed three terms it had never put on a wire, under
         * *"tell them which forms were tried"*. That is a manufactured account
         * of work performed, inside the branch that exists to stop this file
         * manufacturing findings. So the attempt records that it was NOT
         * SEARCHED, and there is exactly one of it.
         */
        if (!client) {
          attempts.push(
            evaluate(rung, { state: 'none', detail: 'Prowlarr is not configured here.' }, {
              isAudio,
              wantsGraphic,
              work,
              searched: false,
              takeUsenet: false,
            }),
          );
          break;
        }
        // 7020 is the ebook bucket. This client has no EPUB-only category, so
        // non-EPUB rows are dropped after the search rather than requested.
        const result: SearchResult = await client.search(
          rung.term,
          isAudio ? CATEGORY.audiobook : CATEGORY.ebook,
        );
        const attempt = evaluate(rung, result, {
          isAudio,
          wantsGraphic,
          work,
          searched: true,
          takeUsenet: sabAcceptsUsenet(ctx.config, isAudio),
        });
        attempts.push(attempt);
        if (attempt.candidates.length > 0) break;
        if (result.state === 'unknown') break;
        /**
         * IRC was asked concurrently with rung one, so this costs nothing it has
         * not already spent. If a bot is holding THE BOOK there is nothing left
         * for a broader torrent search to find.
         *
         * 🔴 IDENTITY-FILTERED, NOT `results.length > 0`. The Prowlarr side of
         * this loop stops on candidates that survived `matchWork` precisely
         * because rows are not answers; stopping on RAW IRC rows would let a bot
         * holding a study guide end the ladder one rung short of the book, which
         * is the original defect with the source swapped.
         */
        ircSettled ??= await ircPromise;
        if (ircHolds(ircSettled, work)) break;
      }
      const ircFound = ircSettled ?? (await ircPromise);

      /**
       * The rung that ANSWERED — or, when none did, THE MOST INFORMATIVE FAILURE
       * rather than the first one.
       *
       * ⚠️ THAT ORDER IS NOT COSMETIC. A rung that returned five copies of the
       * WRONG volume knows something a rung that returned nothing does not, and
       * the branches below split on exactly that: "none of these is that book"
       * names what it found and shows it, while "nothing matched" cannot. Taking
       * the first rung unconditionally would throw the richer finding away and
       * report the thinner one.
       *
       * Either way EVERY rung that ran travels with the report: what was tried
       * is the difference between "not found" and "does not exist".
       */
      const best =
        attempts.find((a) => a.candidates.length > 0) ??
        attempts.find((a) => a.before > 0) ??
        attempts[0]!;
      const { found, before, releases, deadCount } = best;
      const tried = describeAttempts(attempts);

      let ircOffers: Offer[] = [];
      let ircNote = '';
      if (hasIrc) {
        if (ircFound.state === 'ok') {
          ircOffers = ircFound.results
            .filter((r) => isAudio || isEpubClaim(r.title))
            .map((r) => ircOffer(r, work));
          if (ircFound.detail) ircNote = `IRC ${ircFound.detail}`;
        } else {
          // 'none' and 'unknown' are both reported, never treated as "no books".
          ircNote = `IRC: ${ircFound.detail}`;
        }
      }

      /**
       * 🔴 An unreachable indexer is UNKNOWN — a failure to LOOK is not a finding
       * of absence. But with IRC offers in hand it is a PARTIAL result, not a
       * dead end, so it degrades to a note instead of taking the whole tool down.
       *
       * ⚠️ IT IS ASKED OF EVERY RUNG, NOT OF `best`. `best` prefers a rung that
       * returned rows, and an unreachable rung returned none — so keying this on
       * `best.found` swallowed an indexer that failed on rung two entirely: no
       * UNKNOWN, no note, and a reply whose head said NOT FOUND while one of the
       * searches it named had never completed. A failure to look outranks a
       * failure to find no matter which rung it happened on.
       */
      const unreachable = attempts
        .map((a) => a.found)
        .find((f): f is Extract<SearchResult, { state: 'unknown' }> => f.state === 'unknown');
      let prowlarrNote = '';
      if (unreachable) {
        if (ircOffers.length === 0) return fail(`UNKNOWN — ${unreachable.detail} (asked ${tried})`);
        prowlarrNote = `the torrent indexers could not be reached (${unreachable.detail})`;
      }
      /**
       * 🔴 AN ABSENCE REPORT MUST NAME WHAT WAS NOT REACHED — AND NOW ALSO WHAT
       * WAS ASKED.
       *
       * Reporting "NONE" while IRC was unreachable states a finding of absence
       * on the strength of one source — the same two-zeros error this file
       * guards everywhere else, just moved up a level.
       *
       * 🔴 AND THE SAME ERROR LIVED IN THE WORDING ITSELF. This branch used to
       * hand the model `NONE — Prowlarr found nothing for that search.`, which
       * came back to Jeff as *"Prowlarr still has no audiobook release for it"*
       * — our search's zero, restated as the world's. So the forms that were
       * tried are named, and the model is told in as many words that this is a
       * search that missed and NOT a book that is absent.
       */
      if (found.state === 'none' && ircOffers.length === 0) {
        if (!isAudio && attempts.some((a) => a.searched)) {
          const reply = bookNoEpub(work ? describeWork(work) : query);
          return {
            ...ok(`NO EPUB — ${reply}${ircNote ? ` (${ircNote})` : ''}`),
            verbatimReply: reply,
          };
        }
        return ok(
          `NOT FOUND — I asked the indexers ${attempts.length} different way(s) about this and none ` +
            // 🔴 THE INDEXER'S OWN DETAIL SURVIVES. It is what separates "nothing
            // came back" from "things came back that nothing can fetch", and
            // dropping it into a generic miss would merge two different findings.
            `of them matched: ${tried}. ${found.detail}${ircNote ? ` (${ircNote})` : ''}\n` +
            '🔴 That is OUR SEARCH failing to find it, NOT a finding that the ' +
            `${medium} does not exist. Tell them which forms were tried and that none matched. Do ` +
            `NOT say there is no ${medium} release, do NOT say it is not on the indexers, and do ` +
            'NOT settle the question by offering something else instead — if you offer an ' +
            'alternative, say in the same breath that the search may simply have missed it.',
        );
      }

      /**
       * 🔴 A FILTER THAT REMOVED EVERYTHING IS NOT "NOTHING EXISTS".
       *
       * Same two-zeros rule as everywhere else, one layer further in: releases
       * were found and OUR filter discarded them all. Reporting "none found"
       * would be a false negative we manufactured, and the useful answer is the
       * one that names the filter — they can just say yes to a dramatisation.
       */
      if (releases.length === 0 && ircOffers.length === 0) {
        return ok(
          `${ircNote ? `[${ircNote}] ` : ''}` +
            `FILTERED OUT — found ${before} ${medium} release(s) for "${query}" (searched ${tried}), ` +
            'but ' +
            (wantsGraphic
              ? 'NONE of them are GraphicAudio dramatisations. Say so and ask whether an ordinary ' +
                'reading is fine.'
              : 'EVERY one is a GraphicAudio dramatisation. Say so and ask whether they want one.'),
        );
      }

      const merged = mergeSources(best.offers, ircOffers);

      if (!isAudio && merged.length === 0 && best.deadCount === 0 && best.usenetSkipped === 0) {
        const reply = bookNoEpub(work ? describeWork(work) : query);
        return { ...ok(`NO EPUB — ${reply}`), verbatimReply: reply };
      }

      /**
       * ═══ STAGE TWO: WHICH COPY ═══════════════════════════════════════════
       *
       * 🔴 A RELEASE THAT IS NOT THIS WORK IS NOT A CANDIDATE, whatever its
       * swarm. This is the line the Corey Olsen study guide fails on 24 seeders
       * while the novel passes on 8.
       */
      const wrongWork = work ? merged.filter((o) => o.work === WORK_MATCH.NOT_THIS_WORK) : [];
      const candidates = work ? merged.filter((o) => o.work !== WORK_MATCH.NOT_THIS_WORK) : merged;
      let top = candidates.slice(0, 5);

      /**
       * ═══ MAKE THE AUTO-PICK GRABBABLE BY CONSTRUCTION ══════════════════════
       *
       * 🔴 A REGRESSION THE 1337x FIX INTRODUCED, AND THE INVARIANT IT BROKE.
       *
       * Unfetchable releases used to be dropped BEFORE ranking, so whatever
       * ranked top could always be grabbed. Keeping the RESOLVABLE ones removed
       * that guarantee without removing the sentence that depended on it: the
       * tool says *"I took the healthiest swarm myself"* and the grab can then
       * fail on that very release, while a good copy sits one row down. To the
       * person testing it, a confident pick that will not fetch reads as "the
       * fix did not work".
       *
       * So the chosen release is RESOLVED HERE, walking down until one answers.
       *
       * ⚠️ ONLY WHEN A WORK IS PINNED, AND THAT CONDITION IS THE WHOLE SAFETY OF
       * IT. Every candidate has been scored as a COPY OF THE SAME BOOK, so
       * moving down the list answers "which copy" — explicitly not the person's
       * decision. On the unpinned path the candidates are DIFFERENT WORKS, and
       * walking down there would quietly fetch a different book; that path still
       * resolves at grab time, where a failure is reported rather than routed
       * around.
       *
       * ⚠️ Bounded. Each attempt is a request against a service whose own client
       * warns about hammering, and a page of dead links should not become a
       * page of requests.
       */
      if (work && top.length > 0) {
        // Named apart from the ladder's `tried` above: this one is copies we
        // failed to turn into a magnet, not query forms we asked.
        const unfetchable: string[] = [];
        let resolvedTop: Offer | undefined;
        for (const offer of top.slice(0, MAX_RESOLVE_ATTEMPTS)) {
          const v = offer.value;
          if (v['protocol'] === 'usenet' || v['source'] !== 'prowlarr' || isValidInfoHash(v['infoHash'])) {
            resolvedTop = offer;
            break;
          }
          const downloadUrl = typeof v['downloadUrl'] === 'string' ? v['downloadUrl'] : '';
          if (!downloadUrl) continue;
          const got = await resolveMagnet(downloadUrl, fetchImpl);
          if (got.state === 'magnet') {
            // Recorded on the option itself, so the consumer grabs what was
            // actually checked rather than resolving a second time.
            resolvedTop = { ...offer, value: { ...v, infoHash: got.infoHash, magnetUri: got.magnetUri } };
            break;
          }
          unfetchable.push(`${offer.label.split(' — ')[0]} (${got.detail})`);
        }
        if (!resolvedTop) {
          return ok(
            `COULD NOT FETCH — "${describeWork(work)}" is on the indexers (found by asking ` +
              `${tried}), but none of the ${unfetchable.length} copy(ies) tried could be turned ` +
              `into something the download client can take: ${unfetchable.slice(0, 3).join('; ')}. ` +
              'Say the copies could not be started — do NOT say the book does not exist, and do ' +
              'not offer one of these anyway.',
          );
        }
        // The resolved one leads; the rest stay as alternatives.
        top = [resolvedTop, ...top.filter((o) => o !== resolvedTop && o.value !== resolvedTop.value)];
      }

      /**
       * Everything was found and everything we can fetch is dead. Same two-zeros
       * rule as the filters above: say which, do not report absence.
       *
       * ⚠️ TESTED ON `merged`, NOT ON `top`, SO THAT THE WORK FILTER CANNOT
       * MASQUERADE AS A DEAD SWARM. "every copy is unseeded" and "none of these
       * is the book you asked for" are different findings with different next
       * moves, and collapsing them would report the wrong one whenever the
       * identity filter emptied the list.
       */
      if (merged.length === 0) {
        if (best.usenetSkipped > 0) {
          const why = isAudio
            ? 'Audiobook downloads are torrents, so a Usenet NZB was not offered to qBittorrent.'
            : 'SABnzbd is not fully configured (SABNZBD_URL, SABNZBD_API_KEY, SABNZBD_STORAGE_PREFIX, and SABNZBD_LOCAL_DIR), so those copies were not offered.';
          return ok(
            `USENET HELD — found ${best.usenetSkipped} Usenet release(s) for "${query}" (searched ` +
              `${tried}). ${why}` +
              (best.deadCount ? ` ${best.deadCount} torrent release(s) had NO seeders and were left out.` : '') +
              ' Nothing was chosen. Do NOT say the Usenet copies have no seeders, and do NOT say the ' +
              'book does not exist.',
          );
        }
        return ok(
          `ALL DEAD — found ${releases.length} ${medium} release(s) for "${query}" (searched ` +
            `${tried}) and every one has NO seeders, so none of them would ever finish. Nothing was ` +
            'chosen. Say so; do not say nothing was found.',
        );
      }

      /**
       * 🔴 THE WORK IS PINNED AND NOTHING ON OFFER IS A COPY OF IT.
       *
       * A third kind of zero, and the useful answer names the filter rather than
       * reporting absence — exactly the rule the GraphicAudio and dead-swarm
       * branches already follow. It also does NOT fall back to the unfiltered
       * list: quietly ranking the guides again the moment the filter finds
       * nothing is a fail-open, and it would fire on precisely the searches
       * where the filter was doing its job.
       */
      if (top.length === 0 && work) {
        /**
         * ⚠️ THIS USED TO END *"tell them the book itself does not appear to be
         * on the indexers"*, AND THAT SENTENCE WAS THE SAME LIE ONE BRANCH OVER.
         *
         * The ladder has now asked in every form it knows, and this is still
         * only evidence that OUR searches did not turn up a copy. A search that
         * missed and a book that is absent are indistinguishable from here, so
         * the report says what was tried and stops short of the claim.
         */
        return ok(
          `NOT THE BOOK — I searched ${attempts.length} way(s) (${tried}) and the ` +
            `${merged.length} ${medium} release(s) that came back are not copies of ` +
            `"${describeWork(work)}". They are things like: ` +
            `${wrongWork.slice(0, 3).map((o) => `${o.label.split(' — ')[0]} (${o.work === WORK_MATCH.NOT_THIS_WORK ? 'not that book' : 'partial'})`).join('; ')}. ` +
            'Say that none of what these searches turned up is that book, and name the forms that ' +
            'were tried. Do NOT say the book is not on the indexers and do NOT say nothing was ' +
            'found — neither is something this can tell. Do NOT offer any of these instead.',
        );
      }

      ctx.choices.present({
        senderHandle: ctx.senderHandle,
        subject: query,
        // 🔴 The kind the consumer declares it needs. See types.ts and the
        // note on presentsChoiceKinds above.
        kind: isAudio ? 'audiobook-release' : 'ebook-release',
        options: top.map((o, i) => ({ n: i + 1, label: o.label, value: o.value })),
      });

      const notes: string[] = [];
      if (deadCount) notes.push(`${deadCount} with no seeders left out (they would never finish)`);
      if (isAudio && before > releases.length) {
        notes.push(`${before - releases.length} GraphicAudio release(s) left out`);
      }
      // Found-but-unfetchable is reported: "nothing found" and "found things we
      // cannot fetch" are different answers.
      if (found.state === 'results' && found.discarded) {
        notes.push(`${found.discarded} more had no infoHash or download link and cannot be fetched`);
      }
      if (wrongWork.length) notes.push(`${wrongWork.length} that are not that book left out`);
      if (best.usenetSkipped) {
        notes.push(
          `${best.usenetSkipped} Usenet release(s) left out (${
            isAudio ? 'audiobooks are grabbed as torrents' : 'SABnzbd is not configured'
          })`,
        );
      }
      /**
       * 🔴 A RESULT THAT ONLY A BROADER FORM FOUND SAYS SO. The first form
       * finding nothing is exactly the state that used to be reported as "no
       * release exists"; when a later rung rescues it, that is worth seeing in
       * the transcript rather than being smoothed away.
       */
      if (best !== attempts[0] && best.candidates.length > 0) {
        // ⚠️ GATED ON `best` HAVING ACTUALLY PRODUCED CANDIDATES, and counted by
        // this rung's POSITION rather than by how many ran. Without the gate the
        // note fires on the "most informative failure" fallback and credits a
        // rung for a release it never returned — an IRC offer, say.
        notes.push(
          `the first ${attempts.indexOf(best)} way(s) of asking found nothing — this came from ` +
            `searching ${best.rung.form} ("${best.rung.term}")`,
        );
      }
      if (prowlarrNote) notes.push(prowlarrNote);
      if (ircNote) notes.push(ircNote);
      const suffix = notes.length ? ` (${notes.join('; ')})` : '';

      /**
       * ── 🔴 THE BOOK PATHS ASK. THE EPISODE PATH DOES NOT. ──────────────────
       *
       * Jeff's rule — *"don't give users a choice of which torrent to choose,
       * just choose the best one"* — is a rule about choosing between COPIES OF
       * ONE THING, and it is right wherever that is what the candidates are.
       *
       * `search_episode` is safe by construction: it takes a title, a season and
       * an episode, resolves them against Sonarr to ONE `episodeId`, and asks
       * Sonarr for the releases OF THAT EPISODE. Every candidate is an encoding
       * of the same work, so ranking answers **"which copy"** and swarm health
       * is exactly the right instrument.
       *
       * These two tools take FREE TEXT. Prowlarr and the IRC bots return
       * whatever loosely matches it, so the candidates are **different works**
       * and ranking is being asked **"which thing"** — a question a seeder count
       * cannot answer and was never asked to.
       *
       * ⚠️ MEASURED, LIVE, 2026-08-27. *"The Hobbit J.R.R. Tolkien"* ranked:
       * (1) a Corey Olsen **study guide**, 24 seeders — AUTO-PICKED; (2) a
       * 1937-2017 booklet, 10; (3) **the actual novel**, 8; (4) a four-book
       * collection, 8; (5) LotR+Hobbit, 6. **The ranking was correct.** The
       * top-ranked release was not the book, and no reordering fixes that,
       * because the defect is in the question.
       *
       * The only thing that caught it was the model noticing and refusing to
       * send the study guide — enforcement by a reader, which is what
       * `search_episode`'s old *"do NOT grab 4K"* description was before it
       * became a filter in code. So the list is RETURNED, and the consumer
       * below refuses to act without a number.
       *
       * ── 🔴 SO WHICH BRANCH RUNS IS DECIDED BY WHETHER A WORK IS PINNED ────
       *
       * With a work: every candidate has been scored as a copy of THAT book, so
       * the question left is "which copy" and it is answered here, on the swarm.
       * Nobody is asked about a torrent — Jeff's rule, restored, and now resting
       * on the same precondition it always needed.
       *
       * Without one — the catalogue was unreachable, or knows no such book, or
       * the query names no work exactly — the precondition is absent and the
       * honest thing is the 2.0.1 behaviour: hand back the list and ask. That is
       * a DEGRADED path and it is labelled as one, so nobody reads a fallback as
       * the design.
       */
      if (work) {
        // Named apart from the `best` ATTEMPT above: that one is a query form,
        // this one is a release.
        const bestOffer = top[0]!;
        const choiceLine =
          bestOffer.value['protocol'] === 'usenet'
            ? `the indexer listed a Usenet copy and I took that. Being listed is not a finished download and not a promise it will complete: ${bestOffer.label}`
            : `I took the healthiest swarm myself: ${bestOffer.label}`;
        return ok(
          `CHOSE — "${describeWork(work)}" is the book, and among the ${top.length} release(s) that ` +
            `are copies of it ${choiceLine}${suffix}.\n` +
            'Do NOT list releases and do NOT ask which torrent they want — that choice is already ' +
            `made and it is not theirs. Call ${consumer} now with choice 1. Nothing is ` +
            `${isAudio ? 'downloading' : 'being sent'} yet.`,
        );
      }

      const lines = top.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n');
      return ok(
        `FOUND ${top.length} for "${query}"${suffix}. ⚠️ The book catalogue could not settle which ` +
          `book this is${workNote ? ` — ${workNote}` : ''}, so these are ranked by swarm health ` +
          `alone. A ${medium} search matches on TEXT, so they are very likely DIFFERENT WORKS — a ` +
          'study guide, a companion, a boxed set, the book itself — and NOT copies of one book. ' +
          'Option 1 is NOT "the best one" in any sense that matters here.\n' +
          `${lines}\n` +
          'SHOW THEM THIS LIST and ASK WHICH BOOK THEY MEANT. Do not choose for them and do not ' +
          `assume option 1. If none of these is the book they want, say so and offer to search ` +
          `again with the author's name. Call ${consumer} ONLY once they have answered, with the ` +
          `number they chose. Nothing is ${isAudio ? 'downloading' : 'being sent'} yet.`,
      );
    },
  };
}

/**
 * ⚠️ `openLibrary` IS A TEST SEAM, and it is the reason these signatures grew a
 * parameter rather than the client being constructed from a module constant.
 * Without it every book test would reach the real openlibrary.org — slow,
 * flaky, and rude to a free service that asks callers to identify themselves.
 */
export function makeSearchAudiobook(fetchImpl?: FetchImpl, openLibrary?: OpenLibraryOptions): Tool {
  return makeReleaseSearch('audiobook', fetchImpl, undefined, openLibrary);
}

export function makeSearchEbook(
  fetchImpl?: FetchImpl,
  irc?: IrcEbooks,
  openLibrary?: OpenLibraryOptions,
): Tool {
  return makeReleaseSearch('ebook', fetchImpl, irc, openLibrary);
}

/**
 * GraphicAudio dramatisations are a full cast production, not a reading — much
 * larger, and not what someone asking for "the audiobook" usually means. Matched
 * loosely because release names spell it every way: `GraphicAudio`,
 * `Graphic Audio`, `GRAPHIC-AUDIO`.
 */
function isGraphicAudio(r: Release): boolean {
  // 🔴 THE SAME REGEX THE CLASSIFIER USES. Two copies drifted and the narrower
  // one let spellings through the filter that then scored 0 on the ranker.
  return GRAPHIC_AUDIO.test(r.title);
}

function describe(r: Release): string {
  const how =
    r.protocol === 'usenet'
      ? 'Usenet (listed by the indexer; download success is not guaranteed)'
      : describeSwarm(r.seeders);
  return `${r.title} — ${humanSize(r.sizeBytes)}, ${how}, ${r.indexer}`;
}

/**
 * Usenet ebooks are fetched only when SABnzbd can accept a job AND this
 * process can read the finished folder. Audiobooks stay torrents.
 */
function sabAcceptsUsenet(
  config: { sabnzbd: { baseUrl: string; apiKey: string; storagePrefix: string; localDir: string } },
  isAudio: boolean,
): boolean {
  if (isAudio) return false;
  const sab = config.sabnzbd;
  return Boolean(sab.baseUrl.trim() && sab.apiKey.trim() && sab.storagePrefix.trim() && sab.localDir.trim());
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unknown';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * ── ONE RUNG OF THE QUERY LADDER, ALREADY FILTERED ──────────────────────────
 *
 * Everything the caller needs to decide whether this rung ANSWERED and, if no
 * rung did, to report honestly what each one came back with.
 */
interface Attempt {
  rung: SearchTerm;
  found: SearchResult;
  /**
   * 🔴 DID THIS TERM ACTUALLY GO ON A WIRE. A rung that was never sent must
   * never be reported as a rung that came back empty — see the no-client branch
   * in the loop.
   */
  searched: boolean;
  /** What the indexers returned, before any filter of ours. */
  before: number;
  /** After the GraphicAudio preference — the population the notes count from. */
  releases: Release[];
  deadCount: number;
  /** Usenet rows left out of the offer list. They are not a dead swarm. */
  usenetSkipped: number;
  /** Ranked, identity-scored, dead swarms removed. Wrong works still included. */
  offers: Offer[];
  /**
   * 🔴 THE LADDER'S STOP CONDITION, AND IT IS DELIBERATELY NOT "ROWS CAME
   * BACK". These are the offers that survived the identity filter — the ones a
   * person could actually be given. A rung that returns five copies of a
   * different book has found nothing, and the measured defect is exactly that
   * shape: three results, none of them the audiobook that was asked for.
   *
   * ⚠️ Torrent-only, by construction. IRC is asked once rather than per rung,
   * so folding it in here would make the stop condition depend on a source the
   * ladder is not walking.
   */
  candidates: Offer[];
}

/** One rung's worth of Prowlarr: search results in, filtered offers out. */
function evaluate(
  rung: SearchTerm,
  found: SearchResult,
  o: { isAudio: boolean; wantsGraphic: boolean; work?: Work; searched: boolean; takeUsenet: boolean },
): Attempt {
  const all = found.state === 'results' ? found.releases : [];
  const releases = o.isAudio ? all.filter((r) => isGraphicAudio(r) === o.wantsGraphic) : all;
  const claimed = o.isAudio ? releases : releases.filter((r) => isEpubClaim(r.title));
  /**
   * 🔴 A DEAD TORRENT IS NEVER A CANDIDATE NOW THAT NOBODY IS ASKED.
   *
   * While a person picked from a list, a 0-seeder release at the bottom was
   * merely a bad option they would not take. A comparator that picks silently
   * can take it, and the Fringe pool is what that costs: 60 hours, zero bytes.
   * So it is FILTERED, and counted rather than dropped quietly — "found
   * nothing" and "found only things that will never finish" are different
   * answers. IRC offers are unaffected: a DCC transfer has no swarm to be dead.
   */
  /**
   * A missing or zero seeder count kills a TORRENT. It does not kill a Usenet
   * row: NZBs do not have seeders. Usenet is still withheld when this deploy
   * cannot fetch it, and that withholding is counted separately from the dead
   * swarm so the two are not reported as the same fact.
   */
  const torrents = claimed.filter((r) => r.protocol !== 'usenet');
  const usenet = claimed.filter((r) => r.protocol === 'usenet');
  const alive = torrents.filter((r) => swarmHealth(r.seeders) !== 'dead');
  const usable = o.takeUsenet ? [...alive, ...usenet] : alive;
  const usenetSkipped = o.takeUsenet ? 0 : usenet.length;

  /**
   * 🔴 THE AUDIOBOOK RANKER IS THE ONE WITH A QUALITY KEY UNDER THE BAND.
   *
   * `rankReleases` orders on the band and then on seeders, which — with no
   * third key — is the same ORDER as sorting on seeders alone. That makes its
   * band decorative on its own, and a decorative rule is one nobody notices
   * deleting. `rankAudiobooks` puts `unabridged` UNDER the band, so an abridged
   * copy that people are actually seeding beats an unabridged one that nobody
   * is — which is the whole rule, stated where it bites.
   *
   * Ebooks keep `rankReleases` because their quality key is FORMAT, and the
   * merge comparator applies it across both sources at once.
   *
   * ⚠️ THERE IS NO `.slice(0, 5)` HERE, AND THAT IS A FIX RATHER THAN TIDYING.
   * Truncating to five on SEEDERS before identity is considered would let the
   * defect survive its own fix on a busier title: five well-seeded guides at
   * the top and the novel sixth, cut before anything asked whether it was the
   * book. Measured on the Hobbit the novel came fourth — inside five by luck,
   * not by design. The cut happens after the identity filter, in the caller.
   */
  const offers: Offer[] = (
    o.isAudio ? rankAudiobooks(usable, { wantGraphicAudio: o.wantsGraphic }) : rankReleases(usable)
  ).map((r) => ({
    label: describe(r),
    work: o.work ? matchWork(r.title, o.work).score : WORK_MATCH.PARTIAL,
    band: r.protocol === 'usenet' ? swarmRank(HEALTHY_IRC_BAND) : swarmRank(r.seeders),
    format: o.isAudio ? 0 : formatScore(r.title),
    seeders: r.protocol === 'usenet' ? 0 : r.seeders,
    value: {
      source: 'prowlarr',
      protocol: r.protocol,
      infoHash: r.infoHash,
      title: r.title,
      ...(r.magnetUri ? { magnetUri: r.magnetUri } : {}),
      // 🔴 Carried so the consumer can RESOLVE a release that has no infoHash
      // yet. Without this the pick reaches the grab with nothing to fetch —
      // see resolveMagnet in prowlarr.ts.
      ...(r.downloadUrl ? { downloadUrl: r.downloadUrl } : {}),
    },
  }));

  return {
    rung,
    found,
    searched: o.searched,
    before: all.length,
    releases,
    deadCount: torrents.length - alive.length,
    usenetSkipped,
    offers,
    candidates: o.work ? offers.filter((x) => x.work !== WORK_MATCH.NOT_THIS_WORK) : offers,
  };
}

/**
 * 🔴 WHAT WAS ASKED, AND WHAT EACH ASKING CAME BACK WITH.
 *
 * This string is the whole difference between *"there is no audiobook release"*
 * and *"three ways of searching did not turn one up"*. It names the FORM in
 * words and the TERM verbatim, so a person reading the reply can see the search
 * that ran and try one it did not.
 */
function describeAttempts(attempts: Attempt[]): string {
  return attempts.map((a) => `${a.rung.form} — "${a.rung.term}" → ${outcome(a)}`).join('; ');
}

function outcome(a: Attempt): string {
  if (!a.searched) return 'NOT SEARCHED';
  if (a.found.state === 'unknown') return 'could not be reached';
  if (a.before === 0) return 'nothing at all';
  if (a.candidates.length > 0) return `${a.candidates.length} usable`;
  if (a.releases.length === 0) return `${a.before} result(s), all of them the wrong GraphicAudio kind`;
  if (a.usenetSkipped > 0 && a.candidates.length === 0) {
    const torrentRows = a.releases.length - a.usenetSkipped;
    if (torrentRows === 0 || a.deadCount === torrentRows) {
      return `${a.usenetSkipped} Usenet result(s), not offered`;
    }
  }
  if (a.deadCount === a.releases.length) return `${a.before} result(s), every swarm dead`;
  return `${a.before} result(s), none a copy of that book`;
}

interface Offer {
  label: string;
  /**
   * 🔴 IS THIS RELEASE A COPY OF THE PINNED WORK — **THE FIRST KEY, ABOVE THE
   * BAND**, and the one exception to `pick-release.ts`'s rule that swarm health
   * leads every release comparator.
   *
   * That rule forbids a QUALITY key above the band, and the reason is the Fringe
   * incident: a well-named release with an empty swarm is the worst option, not
   * the best. This is not a quality key. It answers whether the candidate is the
   * thing that was asked for AT ALL, which is a question that has to be settled
   * before "which of these is healthiest" means anything. A 24-seeder study
   * guide is not a better copy of The Hobbit than an 8-seeder novel; it is not a
   * copy of it.
   *
   * ⚠️ When no work could be pinned every offer gets the same value here, so the
   * key is inert and the order is exactly what it was before. It is never a
   * silent tiebreak.
   */
  work: number;
  /**
   * The swarm band, higher is better — `swarmRank` for a torrent.
   *
   * 🔴 AN IRC OFFER IS BANDED `healthy`, AND THAT IS A CLAIM ABOUT MECHANISM.
   * A DCC transfer has no swarm to be dead: a bot either holds the file and
   * sends it, or it does not answer. Leaving it unbanded would have made a
   * one-seeder torrent outrank a bot that has the book in hand.
   */
  band: number;
  /**
   * Format sanity, higher is better. **A SECOND KEY THAT SITS UNDER THE BAND**,
   * which is the only place a quality judgement is allowed to live.
   */
  format: number;
  /** For the tiebreak only; 0 for IRC, which has no seeder count. */
  seeders: number;
  value: Record<string, unknown>;
}

/**
 * How Kindle-ready a filename looks.
 *
 * ⚠️ THIS WAS THE MODEL'S JOB UNTIL NOBODY WAS PICKING ANY MORE. While a person
 * read the numbered list, the model chose something that was actually a book.
 * A comparator does not: `Dune.Complete.Series.rar` with 90 seeders beat
 * `Dune.azw3` with 8 the moment the format key was only `.epub`-or-not.
 *
 * The accepted set is `ebook-validate.ts`'s `EbookFormat` — the formats that
 * survive validation on the way out. `.mobi` scores 0 rather than being ranked
 * as a book at all: Amazon has rejected it silently since 2022, and `send_ebook`
 * re-chooses away from one anyway.
 */
function formatScore(title: string): number {
  return isEpubClaim(title) ? 2 : 0;
}

function ircOffer(r: IrcResult, work?: Work): Offer {
  const size = r.sizeBytes === undefined ? 'size unknown' : humanSize(r.sizeBytes);
  return {
    // The origin is visible to a human, so a pick is never ambiguous about where
    // it came from — and "via IRC" reads differently from a seeder count.
    label: `${r.title} — ${size}, via IRC (${r.bot})`,
    /**
     * 🔴 AN IRC OFFER IS SCORED FOR IDENTITY EXACTLY LIKE A TORRENT.
     *
     * Its band is a claim about MECHANISM — a bot holds the file or it does not
     * — and exempting it from the band was right for that reason. Exempting it
     * from the identity key would not be: a bot serving `Exploring The Hobbit by
     * Corey Olsen.epub` is holding a study guide in hand, and holding it firmly
     * changes nothing about which book it is. An unscored IRC offer would sit
     * above every torrent on the first key and walk straight past the filter.
     */
    work: work ? matchWork(r.title, work).score : WORK_MATCH.PARTIAL,
    // See `Offer.band`: a DCC transfer has no swarm, so it is not a thin one.
    band: swarmRank(HEALTHY_IRC_BAND),
    format: formatScore(r.ext === '.epub' ? 'x.epub' : r.title),
    seeders: 0,
    // 🔴 The command is stored VERBATIM. It is what the bot expects to see back,
    // and reconstructing it from the label would be the classic way to break it.
    value: { source: 'irc', command: r.command, bot: r.bot, title: r.title },
  };
}

/**
 * Is a bot holding A COPY OF THE PINNED WORK — the IRC half of the ladder's
 * stop condition, scored exactly the way the torrent half is.
 *
 * 🔴 NOT `results.length > 0`. `matchWork` is what separates a copy of the book
 * from a study guide with the same words in its filename, and a stop condition
 * that skips it ends the search on the guide.
 */
function ircHolds(outcome: IrcSearchOutcome, work?: Work): boolean {
  if (outcome.state !== 'ok') return false;
  return outcome.results.some(
    (r) => isEpubClaim(r.title) && (!work || ircOffer(r, work).work !== WORK_MATCH.NOT_THIS_WORK),
  );
}

/** Any positive count banded `healthy`; see `Offer.band` for why IRC gets one. */
const HEALTHY_IRC_BAND = 999;

/**
 * One list, both sources, ONE COMPARATOR.
 *
 * ── 🔴 WHY THIS IS NOT THE INTERLEAVE IT REPLACED ───────────────────────────
 *
 * The old merge alternated the two sources and then re-sorted the whole thing on
 * `isEpub`. That trailing sort was the FINAL comparator, it had no swarm term,
 * and `top[0]` is what gets grabbed — so on the ebook path the shipped code
 * chose a 1-seeder `.epub` over a 500-seeder `.azw3` **while printing "leading
 * on swarm health"**. Ranking then re-ranking is how a first key stops being
 * first, and it is the exact ordering `pick-release.ts` exists to forbid.
 *
 * So there is one score vector, band first, and the merge no longer decides
 * anything: sources are concatenated and the comparator sorts them together.
 *
 * ⚠️ The interleave existed for a real reason — Prowlarr's ebook coverage is
 * thin (7 results where IRC had 27, measured 2026-08-26) and appending IRC after
 * five torrent rows pushed every IRC result off a five-item list. That reason
 * DIES with the numbered list: nothing is truncated for display any more, and
 * IRC offers now compete on the band rather than on their position.
 */
function mergeSources(a: Offer[], b: Offer[]): Offer[] {
  return [...a, ...b].sort(byScore((o) => [o.work, o.band, o.format, o.seeders]));
}
