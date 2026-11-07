/**
 * Prowlarr — finding a release to grab.
 *
 * ── 🔴 WHAT COMES OUT OF HERE IS AN infoHash, NEVER A URL ────────────────────
 *
 * qBittorrent lives inside `gluetun-torrents`' network namespace and **cannot
 * reach Prowlarr**. Handing it a Prowlarr proxy/download URL fails *silently* —
 * V1 saw `pending_count: 1` and a torrent that never materialised. So a release
 * is only usable if it carries an `infoHash`, and the grab builds its own magnet.
 *
 * ⚠️ UPDATED 2026-09-04: a release without one in the JSON is STILL a candidate,
 * because `downloadUrl` REDIRECTS to a magnet that carries the hash — see
 * `resolveMagnet`. What remains true is the sentence above it: qBittorrent is
 * never handed a URL. It is handed a magnet, and the resolve happens here.
 *
 * ── ⚠️ PROWLARR IS SLOW AND HAMMERING IT MAKES THINGS WORSE ──────────────────
 *
 * Searches take 35–45 s on a cold cache, and repeated searches trip per-indexer
 * failure-backoff, which **temporarily disables indexers** — so a retry loop
 * degrades the thing it is retrying against. One search, a long timeout, and an
 * honest UNKNOWN on failure.
 */

import { byScore, swarmRank } from './pick-release.js';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProwlarrOptions {
  /**
   * 🔴 THE BARE ROOT, e.g. `http://10.0.0.10:9696` — no path prefix.
   *
   * Unlike Sonarr/Radarr, Prowlarr has none. `/api/v1` is appended HERE rather
   * than being baked into the base, so the two halves of that fact live in one
   * place: I changed the config default once without changing this line, and the
   * result was a URL missing `/api/v1` that failed as UNKNOWN.
   */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  /** Generous on purpose: a cold search legitimately takes 35–45 s. */
  timeoutMs?: number;
}

/** Prowlarr newznab category ids. */
export const CATEGORY = { ebook: 7020, audiobook: 3030 } as const;

export type ReleaseProtocol = 'torrent' | 'usenet';

/**
 * Prowlarr's `protocol` field. Absent means torrent.
 *
 * A Usenet row often has no `seeders` key at all. Treating that absence as a
 * torrent swarm is what made every NZB look dead. Only an explicit usenet (or
 * nzb) protocol takes the Usenet path; everything else stays a torrent so a
 * real zero-seeder torrent is still excluded.
 */
export function releaseProtocol(raw: unknown): ReleaseProtocol {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return s === 'usenet' || s === 'nzb' ? 'usenet' : 'torrent';
}

export interface Release {
  title: string;
  /**
   * `usenet` rows are fetched as NZBs. They are not a swarm, and `seeders` on
   * them is not a health signal.
   */
  protocol: ReleaseProtocol;
  /**
   * 40 hex characters — or **the empty string**, meaning it must be RESOLVED
   * from `downloadUrl` before this release can be grabbed. See `resolveMagnet`.
   */
  infoHash: string;
  /**
   * The release's OWN magnet URI when it has one.
   *
   * ⚠️ Prefer it over a synthesized magnet: it carries the indexer's TRACKERS,
   * and a bare `xt=urn:btih:` relies on DHT alone, which is markedly slower to
   * find peers. Measured on real Prowlarr output — the `guid` field is itself a
   * full magnet for these indexers.
   */
  magnetUri?: string;
  /**
   * Prowlarr's own download link for this release.
   *
   * 🔴 IT IS NOT A TORRENT FILE — IT IS A 301 TO A MAGNET, AND THAT IS THE
   * WHOLE POINT. Measured 2026-09-04: every 1337x row publishes NO `infoHash`
   * in the JSON, and its `downloadUrl` redirects to a full magnet carrying the
   * hash AND 21 trackers. 8 of 8 rows, two different searches.
   *
   * ⚠️ Kept even for releases that already have an `infoHash`, so the resolve
   * path is available rather than being an inference about which indexer we are
   * talking to.
   */
  downloadUrl?: string;
  seeders: number;
  sizeBytes: number;
  indexer: string;
}

/** What `resolveMagnet` came back with. A failure to LOOK is never a "no". */
export type MagnetResolution =
  | { state: 'magnet'; magnetUri: string; infoHash: string }
  | { state: 'unknown'; detail: string };

/**
 * Turn a Prowlarr `downloadUrl` into a magnet, by reading where it POINTS.
 *
 * ── 🔴 THIS IS THE FIX FOR "THE BOOK IS NOT ON THE INDEXERS" ─────────────────
 *
 * Prowlarr publishes `infoHash` for The Pirate Bay and NOT for 1337x. Measured
 * 2026-09-04:
 *
 *     "Dungeon Crawler Carl"         6 rows, all 1337x,      0 with infoHash
 *     "Project Hail Mary Andy Weir"  3 rows,                 1 with infoHash (TPB)
 *     "Red Rising Pierce Brown"      8 rows,                 3 with infoHash (all TPB)
 *
 * Dungeon Crawler Carl is carried ONLY by 1337x, so the entire series was
 * unfetchable and the tool truthfully reported that nothing could be fetched.
 *
 * The redirect target carries the hash and the indexer's trackers, which is
 * strictly better than a synthesized `xt=urn:btih:` relying on DHT alone.
 *
 * ⚠️ `redirect: 'manual'` IS LOAD BEARING. Following it throws — the target
 * scheme is `magnet:`, which no HTTP client can fetch. The redirect is the
 * payload, not a step on the way to one.
 *
 * ── 🔴 THE MAGNET IS PARSED, NOT PATTERN-MATCHED, AND THAT IS A SECURITY RULE ─
 *
 * The Location header is third-party text that decides what gets downloaded
 * into somebody's library, and it reaches a privileged shell command line.
 *
 * An earlier version read the hash with an UNANCHORED regex over the whole
 * string, and `grabTorrent` corroborated it with a bare substring test. Both
 * read the same unstructured string the same loose way, so they were ONE check,
 * and this got past them:
 *
 *     magnet:?dn=xt=urn:btih:<40 hex A>&xt=urn:btih:<40 hex B>
 *
 * The decoy A lives inside the DISPLAY NAME. It is valid 40 hex, so it passed
 * validation, and it appears in the string, so it passed the substring check —
 * while the single real `xt` names B, which is what a client downloads. It would
 * have reported STARTED, and nothing in V2 would ever have noticed: the
 * audiobook path has no follow-up and no status check.
 *
 * So: parse the URL, require EXACTLY ONE `xt`, and anchor the hash pattern to
 * that parameter's whole value. More than one `xt` is refused rather than
 * guessed at — a magnet naming two torrents is not a magnet we understand.
 */
/** A real magnet with 21 trackers is ~1.5 KB. This is a sanity bound, not a spec. */
const MAX_MAGNET_CHARS = 8192;

export async function resolveMagnet(
  downloadUrl: string,
  fetchImpl?: FetchImpl,
  timeoutMs = 30_000,
): Promise<MagnetResolution> {
  const doFetch = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  let res: Response;
  try {
    res = await doFetch(downloadUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { state: 'unknown', detail: `could not ask Prowlarr where the release points (${(e as Error).message})` };
  }
  // A 200 carrying a Location is not a redirect. Only 3xx means "it is over there".
  if (res.status < 300 || res.status >= 400) {
    return {
      state: 'unknown',
      detail: `Prowlarr answered http ${res.status} rather than redirecting, so there is no magnet to read.`,
    };
  }
  const location = res.headers?.get?.('location') ?? '';
  if (!location) {
    return {
      state: 'unknown',
      detail: `Prowlarr answered http ${res.status} with no Location header, so there is no magnet to read.`,
    };
  }
  if (!location.startsWith('magnet:')) {
    return { state: 'unknown', detail: 'Prowlarr redirected somewhere that is not a magnet.' };
  }
  /**
   * ⚠️ It goes verbatim onto an ssh argv. A real magnet with 21 trackers is
   * ~1.5 KB; anything near ARG_MAX is not a magnet, it is a denial of service.
   */
  if (location.length > MAX_MAGNET_CHARS) {
    return { state: 'unknown', detail: `the magnet is ${location.length} characters, which is not a magnet.` };
  }
  let xts: string[];
  try {
    xts = new URL(location).searchParams.getAll('xt');
  } catch {
    return { state: 'unknown', detail: 'Prowlarr redirected to something that does not parse as a URL.' };
  }
  if (xts.length !== 1) {
    return {
      state: 'unknown',
      detail:
        xts.length === 0
          ? 'the magnet names no torrent at all.'
          : `the magnet names ${xts.length} different torrents, so which one it means is UNKNOWN.`,
    };
  }
  // 🔴 ANCHORED to the whole parameter value. An unanchored match here is the
  // decoy hole described above.
  const found = /^urn:btih:([A-Fa-f0-9]{40})$/.exec(xts[0]!)?.[1] ?? '';
  // Read before the guard: the type predicate narrows the failing branch away.
  const shown = xts[0]!.slice(0, 48);
  if (!isValidInfoHash(found)) {
    return { state: 'unknown', detail: `the magnet carries "${shown}", which is not a valid infoHash.` };
  }
  return { state: 'magnet', magnetUri: location, infoHash: found };
}

export type SearchResult =
  | { state: 'results'; releases: Release[]; discarded: number }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * 🔴 An infoHash is interpolated into a shell command on the PRIVILEGED ssh
 * identity, so it is validated before it can get there.
 *
 * This is the same discipline as `isValidContainerName`, and for the same
 * reason: that validation is the entire defence on that identity. Nothing that
 * is not exactly 40 hex characters ever reaches a command line.
 */
export function isValidInfoHash(v: unknown): v is string {
  return typeof v === 'string' && /^[a-fA-F0-9]{40}$/.test(v);
}

/** Build the magnet ourselves. qBittorrent cannot fetch a Prowlarr URL. */
export function magnetFor(infoHash: string, title: string): string {
  if (!isValidInfoHash(infoHash)) throw new Error(`refusing to build a magnet from "${infoHash}"`);
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(title)}`;
}

export class ProwlarrClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  constructor(private readonly opts: ProwlarrOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * One search. No retry loop — see the backoff note above.
   *
   * Releases with NEITHER an `infoHash` nor a `downloadUrl` are discarded and
   * COUNTED, so "nothing found" and "found things we cannot fetch" stay
   * distinguishable. One with a link is kept and resolved at grab time.
   */
  async search(term: string, category: number): Promise<SearchResult> {
    const url =
      `${this.opts.baseUrl}/api/v1/search?query=${encodeURIComponent(term)}` +
      `&categories=${category}&type=search`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'X-Api-Key': this.opts.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      return {
        state: 'unknown',
        detail:
          `Could not search Prowlarr (${(e as Error).message}). That is a failure to look, NOT a ` +
          'finding that nothing exists — say so rather than reporting no results.',
      };
    }
    if (!res.ok) {
      return { state: 'unknown', detail: `Prowlarr returned http ${res.status}. UNKNOWN, not "none".` };
    }
    let rows: unknown;
    try {
      rows = await res.json();
    } catch {
      return { state: 'unknown', detail: 'Prowlarr returned a body that is not JSON. UNKNOWN.' };
    }
    if (!Array.isArray(rows)) return { state: 'unknown', detail: 'Prowlarr returned an unexpected shape.' };

    let discarded = 0;
    const releases: Release[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      /**
       * 🔴 "NO infoHash" NO LONGER MEANS "NOT GRABBABLE" — THE PREMISE WAS
       * OVERTURNED BY MEASUREMENT, 2026-09-04. See `resolveMagnet`.
       *
       * This used to discard every row without an `infoHash`, on the reasoning
       * that qBittorrent cannot fetch a Prowlarr URL. That reasoning is still
       * true and the conclusion was still wrong: the `downloadUrl` REDIRECTS to
       * a magnet, and reading a redirect is something WE do here, not something
       * qBittorrent has to do in its netns.
       *
       * The cost of the old rule was total for some content — Dungeon Crawler
       * Carl is carried only by 1337x, which publishes no `infoHash`, so the
       * whole series was invisible and the tool said so honestly.
       *
       * ⚠️ A row with NEITHER is still discarded. What narrowed is the
       * definition of unfetchable, not the rule that we do not offer choices
       * nobody can take.
       */
      const infoHash = isValidInfoHash(r['infoHash']) ? r['infoHash'] : '';
      const downloadUrl = typeof r['downloadUrl'] === 'string' ? r['downloadUrl'] : '';
      const protocol = releaseProtocol(r['protocol']);
      /**
       * A Usenet row is fetchable only as an NZB. An infoHash does not give
       * SABnzbd anything to download, so a usenet row with no link is discarded
       * the same way an unfetchable torrent is.
       */
      const unfetchable = protocol === 'usenet' ? !downloadUrl : !infoHash && !downloadUrl;
      if (unfetchable) {
        discarded += 1;
        continue;
      }
      const guid = typeof r['guid'] === 'string' ? r['guid'] : '';
      releases.push({
        title: String(r['title'] ?? ''),
        protocol,
        infoHash,
        ...(downloadUrl ? { downloadUrl } : {}),
        ...(guid.startsWith('magnet:') ? { magnetUri: guid } : {}),
        seeders: Number(r['seeders'] ?? 0),
        sizeBytes: Number(r['size'] ?? 0),
        indexer: String(r['indexer'] ?? '?'),
      });
    }
    if (releases.length === 0) {
      return {
        state: 'none',
        detail: discarded
          ? `Prowlarr returned ${discarded} result(s), but none carried an infoHash OR a download link, ` +
            'so none can be fetched.'
          : 'Prowlarr found nothing for that search.',
      };
    }
    return { state: 'results', releases, discarded };
  }
}

/**
 * Rank releases. Code-owned, deterministic, and SWARM HEALTH FIRST.
 *
 * ⚠️ Ordering is a fixed rule, not a judgement — it is about the SWARM, which
 * the model cannot see better than a comparator can. It used to only decide
 * presentation order; **the top of this list is now the release that gets
 * grabbed**, because nobody is asked which torrent they want any more. See
 * `pick-release.ts` for why the band leads and what it is keyed on.
 *
 * ── ⚠️ BE HONEST ABOUT WHAT THE BAND DOES *HERE* ────────────────────────────
 *
 * With only those two keys, band-then-seeders produces the SAME ORDER as
 * seeders alone, so on this function the band is a statement of contract rather
 * than a behaviour — deleting it would change nothing and no test could catch
 * it. It is kept so that the next key anyone adds lands UNDERNEATH it instead of
 * on top, which is the mistake `search_episode` had made.
 *
 * The rules that actually bite on this path are the dead-swarm FILTER and the
 * merge comparator in `search-release.ts`, and for audiobooks `rankAudiobooks`
 * below, where a real quality key sits under the band.
 */
export function rankReleases(releases: Release[]): Release[] {
  return [...releases].sort(
    byScore((r) => [
      // 🔴 FIRST KEY. A dead swarm never completes however good the name is.
      swarmRank(r.seeders),
      r.seeders, // tiebreak WITHIN a band, never across one
    ]),
  );
}


/**
 * Rank AUDIOBOOK releases.
 *
 * ── 🔴 THE PREFERENCE IS A PARAMETER. THE CLASSIFICATION IS NOT. ─────────────
 *
 * These are different things and V1 conflated them:
 *
 * - **Classifying a RELEASE** as GraphicAudio or abridged reads the indexer's
 *   own title. That is data, structured by convention, and matching it is the
 *   same kind of act as reading a file extension.
 * - **Deciding what the PERSON WANTS** must never be mined from conversation.
 *   V1 ran `/graphic\s*audio/i` over the WHOLE session **including Jedd's own
 *   prior turns**, so *"no, NOT the graphic audio version"* turned the
 *   preference ON by negation-blindness, and Jedd's own listing text then
 *   **re-asserted it for the rest of the window** — a detector reading its own
 *   output and latching.
 *
 * So `wantGraphicAudio` arrives here as a boolean the MODEL set from what the
 * person actually said. Nothing in this file reads a conversation.
 */
export interface AudiobookPrefs {
  /** Set by the model from the person's own words. Never inferred here. */
  wantGraphicAudio: boolean;
}

/**
 * ⚠️ ONE REGEX, EXPORTED, BECAUSE TWO DRIFTED.
 *
 * `search-release.ts` filtered on `/graphic[\s._-]*audio/i` and this file
 * classified on `/graphic\s*audio/i`. Release names spell it every way —
 * `GraphicAudio`, `Graphic Audio`, `GRAPHIC-AUDIO` — so the hyphen and dot
 * spellings passed the FILTER as dramatisations and then scored 0 on the
 * classifier for not being them. With `graphic_audio: true` and equal swarms,
 * `Dune GRAPHIC-AUDIO Unabridged` lost to `Dune Graphic Audio abridged`.
 *
 * The wider one is correct, and there is now only one of it.
 */
export const GRAPHIC_AUDIO = /graphic[\s._-]*audio/i;
const ABRIDGED = /\babridged\b/i;
const UNABRIDGED = /\bunabridged\b/i;

export function classifyAudiobook(title: string): {
  graphicAudio: boolean;
  abridged: boolean;
} {
  // ⚠️ "unabridged" contains "abridged". Check the negation FIRST, or every
  // unabridged release is classified as abridged — the \bn't\b trap in a new
  // costume, and this one is a substring rather than a contraction.
  const unabridged = UNABRIDGED.test(title);
  return {
    graphicAudio: GRAPHIC_AUDIO.test(title),
    abridged: !unabridged && ABRIDGED.test(title),
  };
}

export function rankAudiobooks(releases: Release[], prefs: AudiobookPrefs): Release[] {
  return [...releases].sort(
    byScore((r) => {
      const c = classifyAudiobook(r.title);
      return [
        // 🔴 FIRST KEY, ahead of every judgement about the NAME. A thin swarm
        // outranks a perfectly-labelled unabridged reading nobody is seeding.
        swarmRank(r.seeders),
        c.graphicAudio === prefs.wantGraphicAudio ? 1 : 0, // matches what they asked for
        c.abridged ? 0 : 1, // unabridged unless they said otherwise
        r.seeders, // tiebreak
      ];
    }),
  );
}
