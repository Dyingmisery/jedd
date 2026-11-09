import type { Config } from '../config.js';
import { jellyfinGet, type JellyfinResponse } from '../jellyfin.js';
import { ArrClient, type FetchImpl } from '../media/arr.js';
import { summariseShow } from '../media/seasons.js';
import { fail, ok, type Tool } from './types.js';

/**
 * "Do you have X?" — and, for a show, WHICH SEASONS.
 *
 * ── 🔴 TWO SERVICES, ONE QUESTION, AND NO JOIN BETWEEN THEM ──────────────────
 *
 * Jellyfin knows what is watchable. Sonarr knows what is HELD, season by
 * season. Neither can answer this alone:
 *
 *  - Jellyfin says *"Fringe is in the library"* and cannot say that season 5 is
 *    absent, which is the half the person asking actually wanted.
 *  - Sonarr says *"S1-S3 complete, S4 6/22, S5 missing"* and does not know
 *    whether Jellyfin has finished importing any of it.
 *
 * **Both are asked with the USER'S QUERY, independently.** No code matches a
 * Jellyfin item against a Sonarr row — that would be a fuzzy join between two
 * catalogues with different titles, and a wrong join here reports one show's
 * seasons under another show's name. Two independent lookups against the same
 * question can each be wrong on their own terms; a bad join is wrong in a way
 * neither source could contradict.
 *
 * ── ⚠️ SONARR IS ASKED FOR EVERY QUERY, INCLUDING FILM QUERIES ───────────────
 *
 * Deliberate, and it is the Moneyball rule again: **nothing here infers a media
 * type from the message before looking.** A Sonarr listing that matches nothing
 * costs one request and produces no output; a type guess that gets it wrong
 * costs the answer. `catalogue_search` searches both catalogues for the same
 * reason.
 */

export interface LibrarySearchDeps {
  /** Test seam. Production uses the real `jellyfinGet`. */
  jellyfin?: (config: Config, path: string) => Promise<JellyfinResponse>;
  /** Test seam for the Sonarr half. */
  fetchImpl?: FetchImpl;
}

/** How many Jellyfin rows to print. The season summary is the useful half. */
const MAX_ITEMS = 10;

interface Item {
  name: string;
  year: unknown;
  type: unknown;
  /** False for anything we do not hold a file for. See `held`. */
  held: boolean;
}

/**
 * 🔴 A REMOTE CHANNEL LISTING IS NOT SOMETHING WE HAVE. FOUND LIVE.
 *
 * The first live run of this tool against the real Jellyfin returned THREE
 * matches for "sesame street": the owned series, and two rows named
 * `NF - Sesame Street (2025) (US)` with `Type: "Series"` — IPTV on-demand
 * entries from the Dispatcharr channel, carrying `SourceType: "Channel"` and
 * `LocationType: "Remote"`. The previous renderer counted all three and printed
 * `IN LIBRARY — 3 match(es)`.
 *
 * **That is a false ownership claim, produced by the tool rather than by the
 * model** — the exact class V1's prose guards existed to catch after the fact.
 * No fixture had `SourceType` in it, because nobody knew the field was load-
 * bearing until the live library answered.
 *
 * The discriminator is a field, not a name pattern: `LocationType: "FileSystem"`
 * is a file on disk. Matching the `NF - ` prefix would have been a guess about
 * one provider's naming, and would break the moment a channel is renamed.
 */
function classify(raw: unknown): Item {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof item['Name'] === 'string' ? item['Name'] : '(untitled)',
    year: item['ProductionYear'] ?? '?',
    type: item['Type'] ?? '?',
    held: item['SourceType'] !== 'Channel' && item['LocationType'] !== 'Remote',
  };
}

/** Channel rows arrive duplicated per channel; the NAME is the whole content. */
function uniqueNames(items: Item[]): string[] {
  return [...new Set(items.map((i) => i.name))];
}

export function makeLibrarySearch(deps: LibrarySearchDeps = {}): Tool {
  const jellyfin = deps.jellyfin ?? jellyfinGet;
  return {
    name: 'library_search',
    // Spans several services and degrades partially — but needs at least ONE.
    needsAnyService: ['sonarr', 'radarr', 'jellyfin'],
    description:
      'Search the library for a movie or show by title. Returns what is ACTUALLY there — and for a ' +
      'TV show, WHICH SEASONS are there, which are only partly there, and which are missing. Call ' +
      'this before telling anyone whether something is available, and use the season detail when ' +
      'they ask about a show: "seasons 1-3 complete, season 4 has 6 of 10" is the answer, not "it is ' +
      'in the library". A season listed as missing and NOT monitored will never arrive on its own — ' +
      'they have to ask for it. This does not check Plex. A question that names Plex uses plex_availability.',
    minRole: 'guest',
    writes: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title to search for.' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (!query) return fail('No search query supplied.');

      const path =
        `/Items?searchTerm=${encodeURIComponent(query)}` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=${MAX_ITEMS}&Fields=ProductionYear`;
      const sonarr = new ArrClient({ ...ctx.config.sonarr, fetchImpl: deps.fetchImpl }, 'series');
      const [res, seasons] = await Promise.all([jellyfin(ctx.config, path), sonarr.seasons(query)]);

      /**
       * 🔴 A HALF THAT COULD NOT BE READ IS NEVER RENDERED AS AN ABSENCE.
       *
       * Same three-state discipline as `check_status` and `catalogue_search`,
       * and the same reason: a confident false negative about something Jeff can
       * see in Jellyfin with his own eyes is the expensive failure.
       */
      const seasonLines =
        seasons.state === 'tracked'
          ? seasons.shows.map((s) => `  - ${summariseShow(s)}`)
          : seasons.state === 'unknown'
            ? [`  ⚠️ Could not read Sonarr (${seasons.detail}), so which SEASONS are present is UNKNOWN — not "none".`]
            : [];

      if (!res.ok) {
        /**
         * 🔴 `library_search` is TWO independent lookups against TWO services.
         * "Library search failed" was the lead even when Sonarr had answered —
         * a whole-tool failure label on what was actually a half-tool failure,
         * with the half that WORKED buried under the half that did not. Same
         * naming discipline as `catalogue_search`'s `RADARR IS UNREACHABLE` /
         * `SONARR IS UNREACHABLE`: name WHICH side is missing, and put the
         * working side up top.
         *
         * `jellyfinGet` returns `status === 0` for transport failures and
         * `status >= 400` for HTTP errors. The `RADARR IS UNREACHABLE` wording
         * covers both in `catalogue.ts`, deliberately, because the caller only
         * needs to know "this side did not answer" — not why. Same call here.
         */
        const jellyfinDown =
          `JELLYFIN IS UNREACHABLE — could not read Jellyfin (${res.error}). ` +
          `Whether "${query}" is watchable in Jellyfin is UNKNOWN.`;
        if (seasonLines.length === 0) {
          // Both halves down. Lead with both named.
          const sonarrDown = seasons.state === 'unknown'
            ? ` ⚠️ Could not read Sonarr either (${seasons.detail}), so which SEASONS are present is UNKNOWN — not "none".`
            : '';
          return fail(`${jellyfinDown}${sonarrDown}`);
        }
        // Sonarr half succeeded: lead with what we know, name the gap separately.
        return fail(
          `${jellyfinDown}\nSonarr, which WAS reachable, holds:\n${seasonLines.join('\n')}`,
        );
      }

      const body = res.body as { Items?: unknown[] } | undefined;
      const rows = (Array.isArray(body?.Items) ? body.Items : []).map(classify);
      const items = rows.filter((i) => i.held);
      const streaming = rows.filter((i) => !i.held);
      const alsoOn = streaming.length
        ? `\n(Also listed on the IPTV on-demand channels, which is NOT something we hold: ` +
          `${uniqueNames(streaming).slice(0, 3).join(', ')}.)`
        : '';

      if (items.length === 0) {
        /**
         * ⚠️ NOT IN JELLYFIN IS NOT NOTHING. Sonarr tracking a show with no
         * files is exactly the state behind *"I asked for this weeks ago"* — the
         * show is wanted, monitored and simply has not arrived. Answering a bare
         * "not in the library" there throws away the only useful half.
         */
        const head = `NOT IN THE LIBRARY: we hold no file matching "${query}".`;
        if (seasons.state === 'tracked') {
          return ok(
            `${head} But Sonarr IS tracking it — nothing has been imported into Jellyfin yet:\n` +
              seasonLines.join('\n') + alsoOn,
          );
        }
        if (seasons.state === 'unknown') return ok(`${head}\n${seasonLines.join('\n')}${alsoOn}`);
        return ok(
          `${head} Sonarr is not tracking it either (searched ${seasons.searched} shows).${alsoOn}`,
        );
      }

      const lines = items.slice(0, MAX_ITEMS).map((i) => `  - ${i.name} (${i.year}) [${i.type}]`);
      const seasonBlock = seasonLines.length ? `\nSeasons held (from Sonarr):\n${seasonLines.join('\n')}` : '';
      return ok(
        `IN LIBRARY — ${items.length} match(es) for "${query}":\n${lines.join('\n')}${seasonBlock}${alsoOn}`,
      );
    },
  };
}

/** The registered instance. Kept as a named export so the registry reads as a list. */
export const librarySearch: Tool = makeLibrarySearch();
