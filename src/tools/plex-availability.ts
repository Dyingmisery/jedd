import { ArrClient, type FetchImpl } from '../media/arr.js';
import { typeVerdict, orderForDisplay, type Candidate } from '../media/matching.js';
import { confirmLine, plexCheckerFor, plexStatusLine, titled, type PlexInspect } from '../media/plex.js';
import { sendNumberedPosters } from './catalogue.js';
import { ok, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * "Is X on Plex?" Read only. Identity comes from the arr catalogues, then Plex
 * is asked for that id and a real file. A title hit is not a yes.
 */
export function makePlexAvailability(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'plex_availability',
    needsServices: ['plex'],
    description:
      'Answer whether a movie or show is on Plex. Use this when they name Plex, not library_search ' +
      '(that one is Jellyfin and Sonarr). Read-only: never add, download, or search a release. ' +
      'Pass year when they named one, and seasons ONLY when they named season numbers. If the result ' +
      'says to confirm, ask with that list and do not guess. UNKNOWN is not "not on Plex".',
    minRole: 'guest',
    writes: false,
    presentsChoiceKinds: ['plex-choice'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The title, as they said it.' },
        year: { type: 'number', description: 'The year they named, if they named one.' },
        seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'Season numbers they named. Omit when they did not name any.',
        },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return say('No title supplied.');
      const year = Number(args['year']) > 0 ? Number(args['year']) : undefined;
      const seasons = Array.isArray(args['seasons'])
        ? args['seasons'].map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      const lookup = await lookupCandidates(ctx, query, fetchImpl);
      if (lookup.block) return lookup.block;
      const films = year ? lookup.films.filter((c) => c.year === year) : lookup.films;
      const shows = year ? lookup.shows.filter((c) => c.year === year) : lookup.shows;
      if (year && films.length === 0 && shows.length === 0 && (lookup.films.length || lookup.shows.length)) {
        return say(`I could not find a ${year} match for "${query}", so I did not check Plex.`);
      }
      const verdict = typeVerdict(query, films, shows);
      if (verdict.type === 'none') {
        return say(`I could not find a movie or show matching "${query}", so I did not check Plex by name.`);
      }
      if (verdict.type === 'ambiguous') {
        return ask(ctx, query, [verdict.movie.best, verdict.series.best].map((c, i) => optionOf(c, i === 0 ? 'movie' : 'series', seasons)), fetchImpl);
      }
      if (verdict.pick.contested) {
        const arr = verdict.type === 'movie' ? 'movie' : 'series';
        const pool = arr === 'movie' ? films : shows;
        return ask(ctx, query, orderForDisplay(query, pool).slice(0, 3).map((c) => optionOf(c, arr, seasons)), fetchImpl);
      }
      const best = verdict.pick.best;
      const arr = verdict.type === 'movie' ? 'movie' : 'series';
      return say(await statusFor(ctx, fetchImpl, arr, best.id, best.title, best.year, arr === 'series' ? seasons : []));
    },
  };
}

export async function statusFor(
  ctx: ToolContext,
  fetchImpl: FetchImpl | undefined,
  arr: 'movie' | 'series',
  id: number,
  title: string,
  year: number | undefined,
  seasons: number[],
): Promise<string> {
  const client = plexCheckerFor(ctx.config.plex, fetchImpl);
  if (!client) return 'I cannot check Plex from here.';
  const found: PlexInspect = await client.inspect({ arr, id, seasons, now: new Date() });
  return plexStatusLine(title, year, found, seasons);
}

async function lookupCandidates(ctx: ToolContext, query: string, fetchImpl?: FetchImpl): Promise<
  { films: Candidate[]; shows: Candidate[]; block?: ToolResult }
> {
  const radarr = new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
  const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
  const [films, shows] = await Promise.all([radarr.catalogue(query), sonarr.catalogue(query)]);
  if (films.state === 'unknown' || shows.state === 'unknown') {
    return {
      films: [],
      shows: [],
      block: say('I could not look up that title, so I did not check Plex by name.'),
    };
  }
  return { films: films.candidates, shows: shows.candidates };
}

function optionOf(c: Candidate, arr: 'movie' | 'series', seasons: number[]) {
  return {
    label: `${titled(c.title, c.year)} — ${arr === 'movie' ? 'film' : 'show'}`,
    value: {
      arr,
      id: c.id,
      title: c.title,
      ...(c.year ? { year: c.year } : {}),
      ...(c.network ? { network: c.network } : {}),
      ...(c.posterUrl ? { posterUrl: c.posterUrl } : {}),
      ...(seasons.length ? { seasons } : {}),
    },
  };
}

async function ask(
  ctx: ToolContext,
  query: string,
  options: ReturnType<typeof optionOf>[],
  fetchImpl?: FetchImpl,
): Promise<ToolResult> {
  if (ctx.choices && options.length > 0) {
    ctx.choices.present({
      senderHandle: ctx.senderHandle,
      subject: query,
      kind: 'plex-choice',
      options: options.map((o, i) => ({ n: i + 1, label: o.label, value: o.value })),
    });
  }
  const reply = confirmLine(options.map((o) => o.value), 'check');
  await sendNumberedPosters(ctx, options, fetchImpl);
  return say(reply);
}

function say(reply: string): ToolResult {
  return { ...ok(reply), verbatimReply: reply };
}
