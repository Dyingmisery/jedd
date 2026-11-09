import { ArrClient, type FetchImpl } from '../media/arr.js';
import { typeVerdict, orderForDisplay, type Candidate } from '../media/matching.js';
import { confirmLine } from '../media/plex.js';
import { fetchAllowlistedPoster } from '../media/poster.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/**
 * "Can you get X?" — what COULD be added.
 *
 * 🔴 SEARCHES BOTH CATALOGUES, ALWAYS, AND NEVER GUESSES A TYPE.
 *
 * Measured over 806 real user turns, the modal request is **`verb + bare title`
 * with no type marker** — *"add whiplash"*, *"Get hook"*. The title is the whole
 * payload, so any code that decided film-or-show before searching would be
 * guessing on the majority of real traffic. V1 did exactly that and booked
 * *Moneyball (2021)*, a TV series, when the ask was the 2011 film.
 *
 * When a title matches plausibly in both, this returns AMBIGUOUS and says not to
 * add. That is a code rule rather than a model judgement, so the silent
 * cross-type add is unreachable for the shape of title that caused the defect.
 * A single-catalogue match is still the model's call — what is removed is the
 * *silent* error, not every error.
 */
export function makeCatalogueSearch(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'catalogue_search',
    // Spans several services and degrades partially — but needs at least ONE.
    needsAnyService: ['sonarr', 'radarr'],
    description:
      'Search what COULD be added to the library — films in Radarr and shows in Sonarr, both at once. ' +
      'Use this for "can you get X". Do NOT use it to answer "do you have X" — it searches the ' +
      'catalogue of addable things, not what is owned. If the result says AMBIGUOUS, the title exists ' +
      'as both a film and a show: present both and ask which they meant, and add neither.',
    minRole: 'guest',
    writes: false,
    presentsChoiceKinds: ['media-choice'],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title, as the person said it. Do not add a year or a type.' },
      },
      required: ['title'],
    },
    async run(args, ctx) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      if (!title) return fail('No title supplied.');

      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const radarr = new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
      const [films, shows] = await Promise.all([radarr.catalogue(title), sonarr.catalogue(title)]);

      // 🔴 An unreachable catalogue is UNKNOWN. Reporting "nothing found" when
      // one side could not be searched is a false negative dressed as an answer.
      if (films.state === 'unknown' && shows.state === 'unknown') {
        return fail(
          `Could not search either catalogue, so this is UNKNOWN rather than "not available". ` +
            `Radarr: ${films.detail} Sonarr: ${shows.detail}`,
        );
      }
      if (films.state === 'unknown') {
        return fail(
          `Sonarr searched, but RADARR IS UNREACHABLE (${films.detail}), so I cannot say whether a ` +
            'FILM of this name exists. Report that gap rather than answering as if only shows exist.',
        );
      }
      if (shows.state === 'unknown') {
        return fail(
          `Radarr searched, but SONARR IS UNREACHABLE (${shows.detail}), so I cannot say whether a ` +
            'SHOW of this name exists. Report that gap rather than answering as if only films exist.',
        );
      }

      /**
       * Record the options as a side effect of producing them.
       *
       * The pick-a-number flow failed in V1 because the list did not survive to
       * the next message. It survives here because the tool that generated it
       * persisted it — not because the model remembered to.
       */
      const remember = (opts: { label: string; value: Record<string, unknown> }[]) => {
        if (opts.length === 0) return '';
        // Always include the numbered list in the tool text so the model (and
        // tests) see networks/years even when a choices store is not wired.
        // Persistence is best-effort and must not gate what we say.
        if (ctx.choices) {
          ctx.choices.present({
            senderHandle: ctx.senderHandle,
            subject: title,
            kind: 'media-choice',
            options: opts.map((o, i) => ({ n: i + 1, label: o.label, value: o.value })),
          });
        }
        return opts.map((o, i) => `\n  ${i + 1}. ${o.label}`).join('');
      };

      const verdict = typeVerdict(title, films.candidates, shows.candidates);
      switch (verdict.type) {
        case 'none':
          return ok(
            `NO MATCH — ${verdict.detail} (searched ${films.candidates.length} film and ` +
              `${shows.candidates.length} show result(s)).`,
          );
        case 'ambiguous': {
          const options = [
            optionOf(verdict.movie.best, 'movie'),
            optionOf(verdict.series.best, 'series'),
          ];
          const listed = remember(options);
          const reply = confirmLine(options.map((o) => o.value));
          await sendNumberedPosters(ctx, options, fetchImpl);
          return { ...ok(`AMBIGUOUS — ${verdict.detail}${listed}\n${reply}\nDo not add either. A number they reply is the stored option.`), verbatimReply: reply };
        }
        case 'movie': {
          if (verdict.pick.contested) {
            const options = orderForDisplay(title, films.candidates).slice(0, 3).map((c) => optionOf(c, 'movie'));
            const listed = remember(options);
            const reply = confirmLine(options.map((o) => o.value));
            await sendNumberedPosters(ctx, options, fetchImpl);
            return { ...ok(`FILM (CONTESTED) — do NOT add without asking.${listed}\n${reply}`), verbatimReply: reply };
          }
          return ok(`FILM — ${describe(verdict.pick.best)} (radarr tmdbId ${verdict.pick.best.id}).`);
        }
        case 'series': {
          if (verdict.pick.contested) {
            const options = orderForDisplay(title, shows.candidates).slice(0, 3).map((c) => optionOf(c, 'series'));
            const listed = remember(options);
            const reply = confirmLine(options.map((o) => o.value));
            await sendNumberedPosters(ctx, options, fetchImpl);
            return { ...ok(`SHOW (CONTESTED) — do NOT add without asking.${listed}\n${reply}`), verbatimReply: reply };
          }
          return ok(`SHOW — ${describe(verdict.pick.best)} (sonarr tvdbId ${verdict.pick.best.id}).`);
        }
      }
    },
  };
}

function optionOf(c: Candidate, arr: 'movie' | 'series'): {
  label: string;
  value: { arr: 'movie' | 'series'; id: number; title: string; year?: number; network?: string; posterUrl?: string };
} {
  return {
    label: `${describe(c)} — ${arr === 'movie' ? 'film' : 'show'}`,
    value: {
      arr,
      id: c.id,
      title: c.title,
      ...(c.year ? { year: c.year } : {}),
      ...(c.network ? { network: c.network } : {}),
      ...(c.posterUrl ? { posterUrl: c.posterUrl } : {}),
    },
  };
}

/**
 * Send poster 1, then 2, then 3. Stop at the first miss so a later poster is
 * never shown in an earlier slot. A miss does not change the numbered text.
 */
export async function sendNumberedPosters(
  ctx: ToolContext,
  options: { value: { posterUrl?: string } }[],
  fetchImpl?: FetchImpl,
): Promise<void> {
  if (!ctx.sendImage) return;
  const fetchPoster = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  for (let i = 0; i < options.length; i++) {
    const remote = options[i]!.value.posterUrl;
    if (!remote) return;
    const bytes = await fetchAllowlistedPoster(remote, fetchPoster);
    if (!bytes) return;
    const sent = await ctx.sendImage(`${i + 1}.jpg`, bytes);
    if (!sent) return;
  }
}

function describe(c: Candidate): string {
  const year = c.year ? ` (${c.year})` : '';
  const network = c.network ? ` — ${c.network}` : '';
  return `${c.title}${year}${network}`;
}


