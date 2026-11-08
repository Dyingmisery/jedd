import { ArrClient, type FetchImpl } from '../media/arr.js';
import { addedLine } from '../media/plex.js';
import { fail, ok, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * Adding things. The write half of the media path.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * **No season-phrase parser.** The model turns *"the first 3 seasons"* or
 * *"everything except season 1"* into `seasons: [...]`; this tool only checks
 * that each number exists. Measured over 90 calls, a hand-rolled parser matched
 * the model on 28 of 30 cells and **inverted negation** — *"everything except
 * season 1"* became `[1]`, the exact opposite of the request.
 *
 * **Nothing inspects what the model said.** Every constraint here is on the
 * ARGUMENTS, which makes a wrong call unrepresentable, rather than on the prose,
 * which only detects a wrong claim after it has been made.
 */

/**
 * Schedule the return visit. A turn ends when the user is told the outcome.
 *
 * 🔴 EXPORTED, AND `id` IS THE **TVDB** ID FOR A SERIES — never Sonarr's internal
 * one. `ArrClient.progress()` looks the subject up with
 * `rows.find(r => r.tvdbId === id)`, so passing the internal id matches nothing
 * and the follow-up reports *"is not in the library listing at all"* — a show
 * that reads as having vanished, from a follow-up that was scheduled correctly.
 * `add_season` holds BOTH ids (it needs the internal one for the PUT), which is
 * exactly the situation where the wrong one is easy to hand over.
 */
export async function watchIt(
  ctx: ToolContext,
  arr: 'series' | 'movie',
  id: number,
  title: string,
  seasons: number[],
  observed: string,
  year?: number,
): Promise<string> {
  const followups = ctx.followups;
  // 🔴 A tool must never PROMISE a follow-up it did not manage to schedule.
  if (!followups) return '';
  if (followups.pendingForSubject(ctx.senderHandle, arr, id)) {
    return ' I am already watching this one for you.';
  }
  followups.schedule({
    kind: 'media-add',
    senderHandle: ctx.senderHandle,
    dueAt: new Date(Date.now() + 60 * 60 * 1000),
    reason: `added "${title}"${seasons.length ? ` (season(s) ${seasons.join(', ')})` : ''}`,
    observed,
    subject: { arr, id, title, seasons, ...(year && year > 0 ? { year } : {}) },
  });
  return ' I will check back and tell you how it went, whether or not it works.';
}

export function makeAddMovie(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'add_movie',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['radarr'],
    description:
      'Add a film to the library and start searching for it. Use the tmdbId from catalogue_search — ' +
      'do not invent one. If catalogue_search said AMBIGUOUS, ask which they meant first; do not pick. ' +
      'If Radarr already has the movie but no file is on disk yet, this re-triggers a search rather than ' +
      'claiming it is already watchable.',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        tmdb_id: { type: 'number', description: 'tmdbId from catalogue_search.' },
        title: { type: 'string', description: 'Title, for the confirmation message.' },
        year: { type: 'number', description: 'Release year from the catalogue line, when it had one.' },
      },
      required: ['tmdb_id', 'title'],
    },
    async run(args, ctx) {
      const picked = await lockedPick(ctx, args, 'movie');
      if (picked.block) return picked.block;
      const id = picked.id ?? Number(args['tmdb_id']);
      const title = picked.title || String(args['title'] ?? '').trim();
      const year = picked.year ?? (Number(args['year']) > 0 ? Number(args['year']) : undefined);
      if (!Number.isFinite(id) || id <= 0) return fail('A valid tmdbId is required. Search first.');
      if (ctx.config.readOnly) return refuseWrite();
      if (ctx.followups?.pendingForSubject(ctx.senderHandle, 'movie', id)) {
        return alreadyRequested(title, year);
      }

      const client = new ArrClient({ ...ctx.config.radarr, fetchImpl }, 'movie');
      const outcome = await client.addMovie({
        tmdbId: id,
        title,
        rootFolder: ctx.config.radarr.rootFolder,
        qualityProfileId: ctx.config.radarr.qualityProfileId,
      });
      switch (outcome.state) {
        case 'started': {
          const note = await watchIt(ctx, 'movie', id, title, [], outcome.detail, year);
          return accepted(`STARTED — ${outcome.detail}${note}`, addedLine(title, year, 'movie', []));
        }
        case 'already-have':
          // 🔴 SUCCESS, not failure. Never tell them to retry. Also not "on Plex".
          return accepted(
            `ALREADY_HAVE — ${outcome.detail}`,
            `${title}${year ? ` (${year})` : ''} is already in the movie library. I have not checked Plex.`,
          );
        case 'unknown':
          return notAdded(title, `UNKNOWN — ${outcome.detail}`);
        case 'failed':
          return notAdded(title, `FAILED — ${outcome.detail}`);
      }
    },
  };
}

export function makeAddSeries(fetchImpl?: FetchImpl): Tool {
  return {
    name: 'add_series',
    // Useless without this service; absent rather than always-failing.
    needsServices: ['sonarr'],
    description:
      'Add a TV show, monitor ONLY the seasons asked for, and queue an explicit SeasonSearch for each. ' +
      'Use the tvdbId from catalogue_search — do not invent one. Pass `seasons` as the season numbers ' +
      'the person actually asked for (from what they said and from `available_seasons`); listing extras ' +
      'downloads things nobody asked for. If they did not say which seasons, ask. If the show is already ' +
      'in Sonarr this still turns on the requested seasons and searches — it does not claim "already have" ' +
      'unless those seasons are complete on disk. The result includes a release scout (seeder health on a ' +
      'sample missing episode). If swarms look dead or thin, or a download later sits at 0%, fall through ' +
      'to the gap-fill / episode-release tools that rank by seeder health (and can grab outside the quality profile).',
    minRole: 'guest',
    writes: true,
    parameters: {
      type: 'object',
      properties: {
        tvdb_id: { type: 'number', description: 'tvdbId from catalogue_search.' },
        title: { type: 'string' },
        year: { type: 'number', description: 'First-air year from the catalogue line, when it had one.' },
        seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'ONLY the seasons requested. "The first 3 seasons" is [1,2,3].',
        },
        available_seasons: {
          type: 'array',
          items: { type: 'number' },
          description: 'Every season the show actually has.',
        },
      },
      required: ['tvdb_id', 'title', 'seasons', 'available_seasons'],
    },
    async run(args, ctx) {
      const picked = await lockedPick(ctx, args, 'series');
      if (picked.block) return picked.block;
      const id = picked.id ?? Number(args['tvdb_id']);
      const title = picked.title || String(args['title'] ?? '').trim();
      const year = picked.year ?? (Number(args['year']) > 0 ? Number(args['year']) : undefined);
      const seasons = Array.isArray(args['seasons']) ? args['seasons'].map(Number).filter(Number.isFinite) : [];
      const available = Array.isArray(args['available_seasons'])
        ? args['available_seasons'].map(Number).filter(Number.isFinite)
        : [];
      if (!Number.isFinite(id) || id <= 0) return fail('A valid tvdbId is required. Search first.');
      if (seasons.length === 0) {
        return fail('No seasons given. Ask which seasons they want rather than guessing at all of them.');
      }
      if (ctx.config.readOnly) return refuseWrite();
      if (ctx.followups?.pendingForSubject(ctx.senderHandle, 'series', id)) {
        return alreadyRequested(title, year);
      }

      const client = new ArrClient({ ...ctx.config.sonarr, fetchImpl }, 'series');
      const outcome = await client.addSeries({
        tvdbId: id,
        title,
        seasons,
        availableSeasons: available.length ? available : seasons,
        rootFolder: ctx.config.sonarr.rootFolder,
        qualityProfileId: ctx.config.sonarr.qualityProfileId,
      });
      switch (outcome.state) {
        case 'started': {
          const note = await watchIt(ctx, 'series', id, title, outcome.confirmed, outcome.detail, year);
          return accepted(
            `STARTED — ${outcome.detail}${note}`,
            addedLine(title, year, 'series', outcome.confirmed),
          );
        }
        case 'already-have':
          return accepted(
            `ALREADY_HAVE — ${outcome.detail}`,
            `${title}${year ? ` (${year})` : ''} is already in the show library. I have not checked Plex.`,
          );
        case 'unknown':
          return notAdded(title, `UNKNOWN — ${outcome.detail}`);
        case 'failed':
          return notAdded(title, `FAILED — ${outcome.detail}`);
      }
    },
  };
}

interface Locked {
  block?: ToolResult;
  id?: number;
  title: string;
  year?: number;
}

/**
 * A stored list is the only source of the id while it is open.
 * A bare number selects one option. Two or more options and no number adds nothing.
 * One remaining option is the show they already picked, so a later season add uses it.
 */
async function lockedPick(ctx: ToolContext, args: Record<string, unknown>, arr: 'movie' | 'series'): Promise<Locked> {
  const blank: Locked = { title: '' };
  const pending = ctx.choices?.pending(ctx.senderHandle);
  if (!pending || pending.kind !== 'media-choice') return blank;
  const n = Number(args['choice']);
  if (Number.isInteger(n) && n > 0) {
    const hit = pending.options[n - 1];
    if (!hit) return { title: '', block: fail('That number is not on the list. Nothing was added.') };
    const value = hit.value as { arr?: string; id?: number; title?: string; year?: number };
    if (value.arr !== arr) {
      const other = value.arr === 'movie' ? 'movie' : 'show';
      return { title: '', block: fail(`That number is a ${other}. Nothing was added.`) };
    }
    return {
      id: Number(value.id),
      title: String(value.title ?? ''),
      ...(Number(value.year) > 0 ? { year: Number(value.year) } : {}),
    };
  }
  if (pending.options.length >= 2) {
    return { title: '', block: fail('A numbered list is still open. Nothing was added.') };
  }
  const only = pending.options[0];
  const value = (only?.value ?? {}) as { arr?: string; id?: number; title?: string; year?: number };
  if (value.arr !== arr) return blank;
  return {
    id: Number(value.id),
    title: String(value.title ?? ''),
    ...(Number(value.year) > 0 ? { year: Number(value.year) } : {}),
  };
}

function accepted(content: string, spoken: string): ToolResult {
  return { ...ok(content), verbatimReply: spoken };
}

function notAdded(title: string, content: string): ToolResult {
  return { ...fail(content), verbatimReply: `I could not add ${title}.` };
}

function refuseWrite(): ToolResult {
  return { ...fail('Writes are disabled, so nothing was added.'), verbatimReply: 'Writes are disabled, so nothing was added.' };
}

function alreadyRequested(title: string, year?: number): ToolResult {
  const when = year ? ` (${year})` : '';
  return {
    ...ok('ALREADY_REQUESTED — a watch is already scheduled, so nothing was added again.'),
    verbatimReply: `Your request for ${title}${when} is already in.`,
  };
}
