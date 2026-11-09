import { describeError, redactUrlSecrets } from '../errors.js';
import { plausible, type Candidate } from './matching.js';
import { posterRemoteUrl } from './poster.js';
import { parseQueue, type Release } from './queue.js';
import { parseShowSeasons, type ShowSeasons } from './seasons.js';

/**
 * Sonarr / Radarr.
 *
 * ── 🔴 TWO DIFFERENT QUESTIONS, TWO DIFFERENT ENDPOINTS ──────────────────────
 *
 * *"Do you have X?"* and *"Can you get X?"* are not the same question, and V1
 * answered the first using the second's endpoint.
 *
 *  - **OWNED** — `GET /series`, `GET /movie`. Returns the COMPLETE library.
 *  - **CATALOGUE** — `/series/lookup`, `/movie/lookup`. Returns what COULD be
 *    added, bounded and relevance-ordered.
 *
 * **The bound is the whole problem.** V1 answered "do you have The Office?" from
 * a bounded lookup, and the owned title sat at position 9 of 20 — outside what
 * the model was shown — so Jedd said it was not in the library. **"Not in the
 * top N results" is not "not owned".**
 *
 * The fix here is structural rather than a bigger N: the owned answer is
 * computed by filtering the COMPLETE owned set client-side, so there is no
 * result window for a title to fall outside of.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 🔴 FOUR STATES, AND THEY ARE NEVER COLLAPSED.
 *
 * V1's ebook path read qBittorrent's duplicate-add rejection as a download
 * FAILURE and told the user to retry — the one action guaranteed never to work,
 * wearing a helpful message. **A duplicate add is the SUCCESS case.**
 *
 * `unknown` is not a failure either: it means the write may or may not have
 * happened, which is a different thing to tell a user than "it didn't".
 */
export type AddOutcome =
  | { state: 'started'; detail: string; confirmed: number[] }
  | { state: 'already-have'; detail: string }
  | { state: 'failed'; detail: string }
  | { state: 'unknown'; detail: string };

export interface ArrOptions {
  /**
   * ⚠️ Base URL INCLUDING the path prefix: `http://host:8989/sonarr/api/v3`.
   * The bare host returns something that is not the API, which reads as a
   * broken homelab when it is really a wrong URL — see `probe()`.
   */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /**
   * Test seam ONLY: how `call()` waits between transport-failure retries.
   * Unset in production, where it is a real `setTimeout`. A test that wants
   * to assert the backoff values passes a spy and observes what ms it was
   * asked to wait.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 🔴 ONE RETRY BUDGET FOR EVERY AR RETRY, AND IT IS THE NUMBER THAT BOUNDSTHE
 * USER'S WAIT IN A SINGLE CALL.
 *
 * Issue #99 measured `ms: 17` for the EHOSTUNAGH path — kernel rejects the
 * SYN immediately, so each attempt is fast. Three attempts with 250/500ms
 * backoffs adds ~750ms worst case, which is the same shape as a single
 * slow Sonarr call. **Longer is not "more thorough"** — it is just more
 * latency against a service that is genuinely down, paid by a model that
 * asked once.
 */
export const ARR_RETRY_ATTEMPTS = 3;
export const ARR_RETRY_BASE_MS = 250;

/**
 * 🔴 THREE STATES, AND `unknown` IS NEVER A "NO".
 *
 * An arr that cannot be reached must produce *"I could not check"*, never
 * *"it isn't there"*. A false negative about something Jeff owns is measured as
 * MORE damaging than a false positive, because he can see the title in Jellyfin
 * and Jedd is contradicting the evidence in front of him.
 */
export type LibraryAnswer =
  | { state: 'owned'; matches: Candidate[] }
  | { state: 'absent'; searched: number }
  | { state: 'unknown'; detail: string };

/**
 * Which SEASONS of an owned show are there.
 *
 * 🔴 THREE STATES AGAIN, AND `untracked` IS NOT `unknown`.
 *
 *  - `tracked`   — Sonarr knows this show; here is the per-season truth.
 *  - `untracked` — Sonarr was read successfully and does not have it. A real
 *                  answer: it means nothing is being fetched for it.
 *  - `unknown`   — Sonarr could not be read. Never rendered as "no seasons".
 *
 * Collapsing the middle two is the failure that matters: "Sonarr does not track
 * this" and "I could not ask Sonarr" lead to opposite actions.
 */
export type SeasonAnswer =
  | { state: 'tracked'; shows: ShowSeasons[] }
  | { state: 'untracked'; searched: number }
  | { state: 'unknown'; detail: string };

export interface EpisodeRow {
  id: number;
  season: number;
  episode: number;
  title: string;
  monitored: boolean;
  hasFile: boolean;
  airDate: string | null;
}

/** One row of Sonarr's interactive release search, with WHY it was refused. */
export interface ReleaseOption {
  guid: string;
  indexerId: number;
  title: string;
  indexer: string;
  /** Sonarr's PARSED quality name, e.g. `WEBDL-1080p`. Not scraped from the title. */
  quality: string;
  /** Parsed vertical resolution: 2160, 1080, 720, 480, or 0 when unknown. */
  resolution: number;
  seeders: number;
  sizeBytes: number;
  approved: boolean;
  /** Empty when approved. Otherwise Sonarr's own reasons, verbatim. */
  rejections: string[];
  customFormatScore: number;
  languages: string[];
}

export type CatalogueAnswer =
  | { state: 'results'; candidates: Candidate[] }
  | { state: 'unknown'; detail: string };

export class ArrClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly opts: ArrOptions,
    /** 'series' for Sonarr, 'movie' for Radarr. Decides the endpoint names. */
    private readonly kind: 'series' | 'movie',
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * 🔴 FAIL FAST WHILE A SERVICE IS KNOWN DOWN.
   *
   * `call()` carries a 20s per-request timeout, which is the right ceiling for
   * one slow call. It is the WRONG ceiling for the second one when the first
   * already failed: a Radarr that timed out 3 seconds ago is overwhelmingly
   * likely to time out again in the same window, and the model that asks
   * `catalogue_search` then `add_movie` then `catalogue_search` again — measured
   * 2026-08-31, audit entry 1 + 2 — paid three 20s waits for the same outcome.
   *
   * The breaker is keyed on `baseUrl`, not on the `ArrClient` instance, because
   * the existing call sites construct a fresh client per tool invocation
   * (see `src/tools/catalogue.ts`) and a per-instance counter would observe
   * exactly one failure before being discarded. Across the process the URL is
   * stable, so the URL is the right scope.
   *
   * Only TRANSPORT failures trip it (the catch below). An HTTP 5xx is the
   * service answering; it is a different signal and must not short-circuit a
   * later call, because a service that 500ed once may be fine on the next
   * request. A timeout, a refused connection, a host unreachable, a DNS failure
   * — all of those describe a service that did not answer, and those are what
   * the breaker records.
   *
   * ⚠️ COOLDOWN IS INTENTIONAL, AND THE NUMBER IS A CHOICE NOT A MEASUREMENT.
   * 30s is what `qBittorrent`'s settle loops in `src/tools/qbit.ts` already use
   * for transient-failure backoff in this same codebase, so the same window
   * applies here. The breaker does NOT replace the per-call timeout — the
   * FIRST failure still pays 20s, deliberately, because a single slow call is
   * not the defect; the second and third are.
   *
   * ── 🔴 RETRIES RIDE THROUGH TRANSIENT FAILURES WITHIN ONE CALL ────────────
   *
   * The breaker is a CROSS-CALL optimization; it does nothing for the FIRST
   * call to a service that turns out to be transiently unreachable. Measured
   * 2026-09-30 against a live Sonarr at `192.168.1.7:8989`: the model asked
   * `check_status`, the kernel returned EHOSTUNREACH in 17 ms, and the tool
   * reported UNKNOWN — without retrying. That is correct given one attempt
   * and wrong given that the SAME service often recovers within a second
   * (ARP cache flushing, route re-converging, the container coming back).
   *
   * The retry is bounded — `ARR_RETRY_ATTEMPTS` × `ARR_RETRY_BASE_MS` — and
   * only applies to **transport** failures (the catch below). An HTTP 5xx is
   * the service answering, and re-asking is not safer than not re-asking. The
   * first attempt still pays the full timeout on purpose: a single slow call
   * is not the defect, and a retry budget that masks the first failure
   * silently would hide the signal from the breaker.
   *
   * ⚠️ Breaker state is read OUTSIDE the retry loop — known-down services
   * still short-circuit on the first attempt of the first call, so a Radarr
   * flagged 30s ago does not get a fresh three-attempt retry this turn.
   */
  private async call(path: string): Promise<{ ok: boolean; status: number; body: unknown; detail: string }> {
    const url = `${this.opts.baseUrl}${path}`;
    const cooled = cooledDownFor(this.opts.baseUrl);
    if (cooled) {
      return {
        ok: false,
        status: 0,
        body: null,
        detail:
          `${redactUrlSecrets(this.opts.baseUrl)} failed ${Math.round(cooled.elapsedMs / 1000)}s ago ` +
          `(${cooled.detail}), so I am NOT retrying yet. The same call would time out again — ` +
          'wait, or check the service, then try once.',
      };
    }
    let res: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ARR_RETRY_ATTEMPTS; attempt++) {
      try {
        res = await this.fetchImpl(url, {
          headers: { 'X-Api-Key': this.opts.apiKey },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        break;
      } catch (e) {
        // 🔴 `.message` alone is the constant string "fetch failed" — see src/errors.ts.
        lastErr = e;
        if (attempt < ARR_RETRY_ATTEMPTS) {
          // Exponential backoff: 250ms, 500ms. Bounded — see the constants.
          await this.sleep(ARR_RETRY_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }
    if (!res) {
      const detail =
        `could not reach ${redactUrlSecrets(url)}: ${describeError(lastErr, redactUrlSecrets)} ` +
        `(after ${ARR_RETRY_ATTEMPTS} attempts)`;
      recordTransportFailure(this.opts.baseUrl, detail);
      return {
        ok: false,
        status: 0,
        body: null,
        detail,
      };
    }
    let body: unknown = null;
    let raw = '';
    try {
      raw = await res.text();
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body: null, detail: `http ${res.status} from ${url}` };
    }
    if (body === null) {
      /**
       * ⚠️ A 200 that is not JSON is the WRONG-PREFIX signature, not a broken
       * service: the bare host serves a web app, so the request "succeeds" and
       * returns HTML. Reported distinctly, because "your URL is wrong" and "the
       * homelab is down" lead to completely different actions.
       */
      return {
        ok: false,
        status: res.status,
        body: null,
        detail:
          `${url} returned ${res.status} but the body is not JSON (starts "${raw.slice(0, 40)}"). ` +
          'That is the signature of a MISSING PATH PREFIX — the base URL must include ' +
          '/sonarr/api/v3 or /radarr/api/v3 — not of an unreachable service.',
      };
    }
    return { ok: true, status: res.status, body, detail: '' };
  }

  /**
   * 🔴 THE ID IS SELECTED BY KIND, NEVER BY A `??` CHAIN ACROSS ID SPACES.
   *
   * Found against the LIVE api, not by a fixture: a real Sonarr `/series` row for
   * *The Office (US)* carries **`id: 43` (Sonarr's internal id), `tvdbId: 73244`
   * AND `tmdbId: 2316`** — all three, all different, all valid-looking integers.
   *
   * A precedence chain `tmdbId ?? tvdbId ?? id` therefore returned **2316 for a
   * SERIES**, and Sonarr's add endpoint wants the **tvdbId**. Nothing would have
   * errored: 2316 is a perfectly well-formed number that either finds nothing or,
   * worse, finds a DIFFERENT series. That is the bad-id class in its purest form.
   *
   * Worse still, the field is not even consistently present: **59 of 60 rows had
   * `tmdbId`**, so the chain would have silently changed which id space it
   * returned for one row in the same list. An identifier that is usually right is
   * the hardest kind of wrong.
   *
   * My fixtures could not catch this because each carried only ONE id field, so
   * the precedence never had to choose. A fixture that cannot express the
   * ambiguity cannot test the rule.
   */
  private toCandidates(rows: unknown): Candidate[] {
    if (!Array.isArray(rows)) return [];
    const idField = this.kind === 'series' ? 'tvdbId' : 'tmdbId';
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const raw = row[idField];
      const networkRaw = row['network'];
      const network =
        this.kind === 'series' && typeof networkRaw === 'string' && networkRaw.trim()
          ? networkRaw.trim()
          : undefined;
      const posterUrl = posterRemoteUrl(row);
      return {
        id: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0,
        title: String(row['title'] ?? ''),
        year: typeof row['year'] === 'number' ? row['year'] : undefined,
        network,
        ...(posterUrl ? { posterUrl } : {}),
      };
    });
  }

  /**
   * Is this title in the library?
   *
   * 🔴 Filters the COMPLETE owned set rather than asking the service to search.
   * There is no result window, so a title cannot fall outside one — which is the
   * structural version of the "The Office at position 9 of 20" fix. It costs one
   * full listing per question; the arrs return that in a single response and the
   * library is small enough that this is not the expensive part.
   */
  async owned(title: string, match: (q: string, c: Candidate[]) => Candidate[]): Promise<LibraryAnswer> {
    const res = await this.call(`/${this.kind}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const all = this.toCandidates(res.body);
    const matches = match(title, all);
    if (matches.length > 0) return { state: 'owned', matches };
    return { state: 'absent', searched: all.length };
  }

  /**
   * Per-season availability for every owned show resembling `title`.
   *
   * Same endpoint and same reasoning as `owned()`: the COMPLETE library is
   * filtered here rather than searched remotely, so there is no result window a
   * title can fall outside of.
   *
   * ⚠️ Series only. Calling it on a Radarr client is a programming error, not a
   * runtime one — a movie has no seasons, and answering "no seasons found" for
   * a film would be a true sentence that reads as a defect.
   */
  async seasons(title: string): Promise<SeasonAnswer> {
    if (this.kind !== 'series') {
      return { state: 'unknown', detail: 'seasons() is a Sonarr call; a movie has no seasons.' };
    }
    const res = await this.call('/series');
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const rows = Array.isArray(res.body) ? (res.body as unknown[]) : [];
    const shows = rows.map(parseShowSeasons).filter((s): s is ShowSeasons => s !== null);
    const matches = plausible(title, shows);
    if (matches.length === 0) return { state: 'untracked', searched: shows.length };
    return { state: 'tracked', shows: matches };
  }

  /** What COULD be added. Bounded and relevance-ordered — never used to answer "do you have". */
  async catalogue(term: string): Promise<CatalogueAnswer> {
    const res = await this.call(`/${this.kind}/lookup?term=${encodeURIComponent(term)}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    return { state: 'results', candidates: this.toCandidates(res.body) };
  }

  private async post(path: string, body: unknown) {
    return this.send('POST', path, body);
  }

  private async put(path: string, body: unknown) {
    return this.send('PUT', path, body);
  }

  private async send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown; detail: string }> {
    const url = `${this.opts.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { 'X-Api-Key': this.opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Could not reach it: the write may or may not have landed. UNKNOWN.
      return { ok: false, status: 0, body: null, detail: `could not reach ${url}: ${(e as Error).message}` };
    }
    let parsed: unknown = null;
    let raw = '';
    try {
      raw = await res.text();
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, detail: raw.slice(0, 300) };
  }

  /**
   * Add a series, monitoring ONLY the seasons asked for.
   *
   * 🔴 THE SEASON-SCOPING DEFECT THIS EXISTS TO NOT HAVE.
   *
   * Live instance: a guest asked for *Peppa Pig* "the first 3 seasons" and V1
   * monitored **seasons 1-9**, then grabbed S5 at 52/52 — a season nobody
   * requested — while the requested S2 and S3 sit at 0/52 five months later.
   *
   * The mechanism is `addOptions.monitor`: leaving it at Sonarr's default lets
   * the SERVICE decide, and its decision overrides the per-season flags we set.
   * So the per-season `monitored` array is authoritative AND `monitor: 'none'`
   * is sent explicitly, so nothing downstream re-expands the scope.
   */
  async addSeries(input: {
    tvdbId: number;
    title: string;
    seasons: number[];
    availableSeasons: number[];
    rootFolder: string;
    qualityProfileId: number;
  }): Promise<AddOutcome> {
    if (!input.tvdbId) {
      return { state: 'failed', detail: 'no tvdbId — a series cannot be added without one.' };
    }
    const unknownSeasons = input.seasons.filter((n) => !input.availableSeasons.includes(n));
    if (unknownSeasons.length) {
      return {
        state: 'failed',
        detail:
          `season(s) ${unknownSeasons.join(', ')} do not exist for "${input.title}" ` +
          `(it has ${input.availableSeasons.join(', ')}). Nothing was added.`,
      };
    }
    const res = await this.post('/series', {
      tvdbId: input.tvdbId,
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolder,
      monitored: true,
      seasons: input.availableSeasons.map((n) => ({
        seasonNumber: n,
        monitored: input.seasons.includes(n),
      })),
      // 🔴 'none' so the service does not re-expand what we scoped above.
      // searchForMissingEpisodes is belt-and-suspenders only — measured 2026-09-20 on
      // *Shrinking*: add returned STARTED with this flag set, then S1/S2 sat 0/N for
      // four hours until an explicit SeasonSearch (via add_season) moved them.
      addOptions: { monitor: 'none', searchForMissingEpisodes: true },
    });
    // 🔴 "Already added" is NOT "already watchable" — same shape as addMovie / Breadwinner.
    if (res.status === 400 && /already been added|already exists/i.test(res.detail)) {
      return this.researchExistingSeries(input.tvdbId, input.title, input.seasons);
    }
    if (!res.ok) return this.interpretAdd(res, input.seasons, input.title);

    const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>;
    const seriesId = Number(body['id']);
    if (!Number.isFinite(seriesId) || seriesId <= 0) {
      return {
        state: 'started',
        detail:
          `"${input.title}" was added (season(s) ${input.seasons.join(', ')}), but I could not read ` +
          `Sonarr's series id back, so I could not queue per-season SeasonSearch. Do not assume ` +
          `downloads have started — use add_season or check_status if nothing moves.`,
        confirmed: input.seasons,
      };
    }
    return this.searchSeasonsAndScout(seriesId, input.title, input.seasons, 'added');
  }

  /**
   * Which EPISODES of a series are missing — the gap list.
   *
   * 🔴 `/episode?seriesId=` AND NEVER `/wanted/missing?seriesId=`.
   *
   * **`wanted/missing` SILENTLY IGNORES the seriesId filter.** Measured against
   * the live instance: asking for series 80 returned **1651 records carrying
   * seriesId 191 and 73**. It is well-formed, plausible, and about the whole
   * library — so any per-series conclusion drawn from it is wrong in a way
   * nothing about the response reveals.
   *
   * ⚠️ SCOPED TO ONE SERIES, ON REQUEST. There are ~1600 wanted episodes
   * instance-wide and the overwhelming majority are unsourceable archive shows
   * (Mister Rogers ~750, Suits ~108). Anything that sweeps them hammers indexers
   * for approximately zero yield. There is deliberately no all-series entry point.
   */
  async episodes(
    seriesId: number,
  ): Promise<{ state: 'episodes'; rows: EpisodeRow[] } | { state: 'unknown'; detail: string }> {
    if (this.kind !== 'series') {
      return { state: 'unknown', detail: 'episodes() is a Sonarr call; a movie has none.' };
    }
    const res = await this.call(`/episode?seriesId=${seriesId}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    if (!Array.isArray(res.body)) {
      return { state: 'unknown', detail: `Sonarr's episode list for series ${seriesId} was not an array.` };
    }
    const rows: EpisodeRow[] = [];
    for (const r of res.body as Record<string, unknown>[]) {
      const id = Number(r['id']);
      const season = Number(r['seasonNumber']);
      const episode = Number(r['episodeNumber']);
      if (!Number.isFinite(id) || !Number.isFinite(season) || !Number.isFinite(episode)) continue;
      rows.push({
        id,
        season,
        episode,
        title: String(r['title'] ?? '').trim(),
        monitored: r['monitored'] === true,
        hasFile: r['hasFile'] === true,
        airDate: String(r['airDateUtc'] ?? '') || null,
      });
    }
    return { state: 'episodes', rows };
  }

  /**
   * Every release an indexer has for one episode, INCLUDING the ones the quality
   * profile refuses — with the reason it refused them.
   *
   * ── 🔴 WHY THIS INSTEAD OF CHANGING THE QUALITY PROFILE ──────────────────
   *
   * Jeff asked to *"change the quality profile in order to get more options (or
   * whatever the best way is to fill in gaps)"*. The goal is binding; the
   * mechanism was a guess, and it is the wrong one — **a profile change
   * PERSISTS**. Widen a series to fill one gap and it keeps that profile forever,
   * grabbing unattended: theater rips (`The.Mandalorian.and.Grogu.2026.1080p.HDTS`
   * was auto-grabbed exactly this way) and foreign-language releases that only
   * the `Not English` custom format's **-1000** score is holding back. Those
   * rejections are the system WORKING.
   *
   * This asks the indexers directly, shows what exists and why each was refused,
   * and grabs the one the person picks. **The gap gets filled, the profile is
   * never touched, and the quality call is a human decision instead of a config
   * change that outlives it.**
   *
   * Measured live: 2.0 s for 12 releases on a Seinfeld episode — 2 approved at
   * 720p, and 1080p WEB-DLs sitting there rejected as "not wanted in profile",
   * which is precisely the case Jeff was trying to solve.
   */
  async releasesFor(
    episodeId: number,
  ): Promise<{ state: 'releases'; rows: ReleaseOption[] } | { state: 'unknown'; detail: string }> {
    const res = await this.call(`/release?episodeId=${episodeId}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    if (!Array.isArray(res.body)) {
      return { state: 'unknown', detail: `Sonarr's release search for episode ${episodeId} was not an array.` };
    }
    const rows: ReleaseOption[] = [];
    for (const r of res.body as Record<string, unknown>[]) {
      const guid = String(r['guid'] ?? '');
      const indexerId = Number(r['indexerId']);
      if (!guid || !Number.isFinite(indexerId)) continue;
      const q = ((r['quality'] as Record<string, unknown>)?.['quality'] ?? {}) as Record<string, unknown>;
      rows.push({
        guid,
        indexerId,
        title: String(r['title'] ?? ''),
        indexer: String(r['indexer'] ?? '?'),
        // 🔴 A PARSED FIELD, not the release name. `2160p`, `UHD`, `4K` come and
        // go from titles arbitrarily; this is Sonarr's own determination.
        quality: String(q['name'] ?? 'Unknown'),
        resolution: Number(q['resolution']) || 0,
        seeders: Number(r['seeders'] ?? 0),
        sizeBytes: Number(r['size'] ?? 0),
        approved: r['approved'] === true,
        rejections: Array.isArray(r['rejections']) ? (r['rejections'] as unknown[]).map(String) : [],
        customFormatScore: Number(r['customFormatScore'] ?? 0),
        languages: Array.isArray(r['languages'])
          ? (r['languages'] as Record<string, unknown>[]).map((l) => String(l['name'] ?? '')).filter(Boolean)
          : [],
      });
    }
    return { state: 'releases', rows };
  }

  /**
   * Grab one specific release.
   *
   * 🔴 THIS DOES NOT CONSULT THE QUALITY PROFILE. That is the point — it is how
   * a 1080p release the profile refuses can still fill a gap — and it is also
   * why the profile stops being a safety net here. Whatever this is handed, it
   * takes.
   *
   * ⚠️ Sonarr answers 201 with the release echoed back. That echo is NOT
   * evidence the download started; it is evidence the command was accepted. The
   * caller must re-read the queue to say anything stronger.
   */
  async grabRelease(guid: string, indexerId: number): Promise<{ state: 'accepted' | 'failed' | 'unknown'; detail: string }> {
    if (!guid || !Number.isFinite(indexerId)) {
      return { state: 'failed', detail: 'a release needs both a guid and an indexerId.' };
    }
    const res = await this.post('/release', { guid, indexerId });
    if (res.status === 0) {
      return {
        state: 'unknown',
        detail: `Could not reach Sonarr to grab this, so I do NOT know whether it started. (${res.detail})`,
      };
    }
    if (res.status >= 500) {
      return {
        state: 'unknown',
        detail: `Sonarr answered http ${res.status}, a server error rather than a refusal, so the grab MAY have landed.`,
      };
    }
    if (!res.ok) return { state: 'failed', detail: `Sonarr refused the grab (http ${res.status}): ${res.detail.slice(0, 160)}` };
    return { state: 'accepted', detail: 'Sonarr accepted the release and handed it to the download client.' };
  }

  /**
   * 🔴 THE MISSING VERB: turn seasons ON for a series ALREADY in the library.
   *
   * `addSeries` scopes seasons at CREATE time and that path is unreachable once
   * Sonarr holds the show — it answers 400 "already exists". Measured live: Jeff
   * asked for *Seinfeld season 3* on a series Sonarr already had with S2-S9
   * unmonitored and empty, and V2 had no verb for it at all. V1 does. This is
   * the regression that closes.
   *
   * ── 🔴 THE TRUTH IS A RE-READ, NOT THE PUT'S ECHO ────────────────────────
   *
   * Sonarr's PUT response echoes the object we just sent, so believing it means
   * believing ourselves with extra steps. It looks like verification and it
   * cannot fail in the direction that matters. **So the state is READ BACK with
   * a fresh GET after the write**, and every claim — which seasons are on,
   * whether the series flag stuck, what else moved — comes from that read.
   *
   * This is what catches the LOST UPDATE. Two turns run concurrently (the
   * receiver dispatches inbound messages fire-and-forget), so A can GET, B can
   * GET+PUT, and A's PUT then reverts B's season from a stale snapshot. B's echo
   * agreed with B, so B told someone their season was on while it was being
   * turned back off. Against a re-read, A sees B's season go dark and reports
   * it. `withSeriesLock` then prevents the interleaving outright for the case we
   * control; the re-read covers the one we do not, which is Jeff clicking in
   * Sonarr's own UI.
   *
   * ── ⚠️ IT SENDS THE WHOLE SERIES OBJECT BACK ─────────────────────────────
   *
   * Sonarr's `PUT /series/{id}` replaces the resource. A partial body drops
   * every field it omits — root folder, quality profile, tags. So the object is
   * read with GET, mutated in exactly two places, and returned intact.
   *
   * ⚠️ The second of those two places is the SERIES-level `monitored` flag: a
   * series toggled off grabs nothing however many seasons are switched on. It is
   * flipped when it was off, **read back like everything else**, and reported —
   * because it is a state change beyond the seasons that were asked for, and
   * because seasons monitored under an unmonitored series download nothing.
   */
  async monitorSeasons(
    seriesId: number,
    seasons: number[],
  ): Promise<
    | {
        state: 'updated';
        confirmed: number[];
        /** Read back, never assumed. False means the seasons will grab nothing. */
        seriesMonitored: boolean;
        seriesWasUnmonitored: boolean;
        /** Seasons nobody asked about whose monitored flag moved, or that vanished. */
        othersChanged: number[];
      }
    | { state: 'failed'; detail: string }
    | { state: 'unknown'; detail: string }
  > {
    if (this.kind !== 'series') {
      return { state: 'failed', detail: 'monitorSeasons is a Sonarr call; a movie has no seasons.' };
    }
    if (!Number.isFinite(seriesId) || seriesId <= 0) {
      return { state: 'failed', detail: 'no sonarr series id — nothing to update.' };
    }
    // 🔴 One writer per series at a time. See the header: without this, two
    // concurrent turns lose each other's seasons and both report success.
    return withSeriesLock(`${this.opts.baseUrl}#${seriesId}`, () => this.monitorSeasonsUnlocked(seriesId, seasons));
  }

  private async monitorSeasonsUnlocked(
    seriesId: number,
    seasons: number[],
  ): Promise<
    | { state: 'updated'; confirmed: number[]; seriesMonitored: boolean; seriesWasUnmonitored: boolean; othersChanged: number[] }
    | { state: 'failed'; detail: string }
    | { state: 'unknown'; detail: string }
  > {
    const got = await this.call(`/series/${seriesId}`);
    if (!got.ok) {
      return {
        state: 'unknown',
        detail: `could not read series ${seriesId} before updating it, so NOTHING was changed: ${got.detail}`,
      };
    }
    const series = got.body as Record<string, unknown> | null;
    if (!series || typeof series !== 'object' || Array.isArray(series)) {
      return {
        state: 'unknown',
        detail: `series ${seriesId} came back in a shape I do not recognise, so NOTHING was changed.`,
      };
    }

    const rows = Array.isArray(series['seasons']) ? (series['seasons'] as Record<string, unknown>[]) : [];
    const before = seasonMap(rows);
    /**
     * 🔴 NO SEASON LIST, NO WRITE.
     *
     * `seasons: []` against an endpoint that REPLACES the resource is a
     * destructive body, and what Sonarr does with it is exactly what we have not
     * verified. An unrecognised read is a reason not to write, not a reason to
     * write something simpler.
     */
    if (before.size === 0) {
      return {
        state: 'unknown',
        detail:
          `series ${seriesId} came back with no season list. Refusing to PUT an empty one at an ` +
          `endpoint that replaces the resource, so NOTHING was changed.`,
      };
    }

    const wanted = new Set(seasons.filter((n) => Number.isFinite(n) && n >= 0));
    const present = [...wanted].filter((n) => before.has(n));
    if (present.length === 0) {
      // Nothing we were asked for exists on this series. Writing would flip the
      // series-level flag and change nothing else — a side effect with no point.
      return {
        state: 'failed',
        detail: `series ${seriesId} has none of season ${[...wanted].join(', ')}. Nothing was changed.`,
      };
    }

    const seriesWasUnmonitored = series['monitored'] !== true;
    const updated = {
      ...series,
      monitored: true,
      seasons: rows.map((r) => (wanted.has(Number(r['seasonNumber'])) ? { ...r, monitored: true } : r)),
    };

    const res = await this.put(`/series/${seriesId}`, updated);
    if (res.status === 0) {
      return {
        state: 'unknown',
        detail:
          `Could not reach Sonarr while updating series ${seriesId}, so I do NOT know whether the ` +
          `seasons were turned on. This is not a "no". (${res.detail})`,
      };
    }
    /**
     * 🔴 5xx IS UNKNOWN, NOT FAILED.
     *
     * A 4xx is Sonarr refusing — the write did not happen and saying so is
     * honest. A 502 from a reverse proxy, or a 500 raised after the change was
     * applied, means the write may well have landed. "Nothing was started" is
     * then a claim we cannot back up, which is the same defect as a false
     * success wearing the other coat.
     */
    if (!res.ok) {
      if (res.status >= 500) {
        return {
          state: 'unknown',
          detail:
            `Sonarr answered http ${res.status} updating series ${seriesId}. That is a server-side ` +
            `error, not a refusal, so the change MAY have landed: ${res.detail.slice(0, 160)}`,
        };
      }
      return { state: 'failed', detail: `Sonarr refused the update (http ${res.status}): ${res.detail.slice(0, 160)}` };
    }

    // 🔴 A FRESH READ, not the PUT's echo. See the header.
    const after = await this.call(`/series/${seriesId}`);
    const back = after.ok ? (after.body as Record<string, unknown> | null) : null;
    const backRows = back && !Array.isArray(back) && Array.isArray(back['seasons'])
      ? (back['seasons'] as Record<string, unknown>[])
      : null;
    if (!backRows) {
      return {
        state: 'unknown',
        detail:
          `Sonarr accepted the update to series ${seriesId} but could not be re-read afterwards, so ` +
          `I cannot confirm what actually changed. ${after.ok ? '' : after.detail}`,
      };
    }

    const now = seasonMap(backRows);
    const confirmed = [...wanted].filter((n) => now.get(n) === true).sort((a, b) => a - b);
    const othersChanged: number[] = [];
    for (const [n, was] of before) {
      if (wanted.has(n)) continue;
      // ⚠️ A season that VANISHED is the largest possible "something else
      // changed", and iterating only the rows that came back cannot see it.
      const isNow = now.get(n);
      if (isNow === undefined || isNow !== was) othersChanged.push(n);
    }
    othersChanged.sort((a, b) => a - b);
    return {
      state: 'updated',
      confirmed,
      seriesMonitored: back!['monitored'] === true,
      seriesWasUnmonitored,
      othersChanged,
    };
  }

  /**
   * 🔴 MONITORING ALONE DOWNLOADS NOTHING.
   *
   * Sonarr does not search a season because it was switched on. Without this
   * command the season sits monitored and empty indefinitely — and "monitored"
   * reads, to anyone looking at the UI, exactly like "on its way". A season we
   * monitored but could not search is NOT being downloaded, and the caller must
   * be able to say so separately.
   */
  async seasonSearch(seriesId: number, seasonNumber: number): Promise<{ ok: boolean; detail: string }> {
    const res = await this.post('/command', { name: 'SeasonSearch', seriesId, seasonNumber });
    if (res.status === 0) return { ok: false, detail: `could not reach Sonarr: ${res.detail}` };
    if (!res.ok) return { ok: false, detail: `http ${res.status}: ${res.detail.slice(0, 120)}` };
    return { ok: true, detail: `SeasonSearch queued for series ${seriesId} season ${seasonNumber}` };
  }

  async addMovie(input: {
    tmdbId: number;
    title: string;
    rootFolder: string;
    qualityProfileId: number;
  }): Promise<AddOutcome> {
    if (!input.tmdbId) {
      return { state: 'failed', detail: 'no tmdbId — a movie cannot be added without one.' };
    }
    const res = await this.post('/movie', {
      tmdbId: input.tmdbId,
      title: input.title,
      qualityProfileId: input.qualityProfileId,
      rootFolderPath: input.rootFolder,
      monitored: true,
      addOptions: { searchForMovie: true },
    });
    // 🔴 "Already added" is NOT "already watchable". Measured 2026-09-19: Jeff
    // asked for The Breadwinner (2026); Radarr already had the row with no file;
    // interpretAdd returned already-have ("nothing to do") and Jedd stopped.
    // Re-search when the movie is monitored but hasFile is false.
    if (res.status === 400 && /already been added|already exists/i.test(res.detail)) {
      return this.researchExistingMovie(input.tmdbId, input.title);
    }
    return this.interpretAdd(res, [], input.title);
  }


  /**
   * 🔴 SERIES ALREADY IN SONARR IS NOT "NOTHING TO DO".
   *
   * Measured 2026-09-20 (*Shrinking*): add_series claimed searching, follow-ups
   * sat at S1 0/10 and S2 0/12 for four hours, then abandoned. The next day
   * add_season's monitor + SeasonSearch path actually moved the files. Same
   * class of defect as Breadwinner on Radarr — "already in the library" without
   * files (or without a live search) is unfinished work, not success.
   */
  private async researchExistingSeries(
    tvdbId: number,
    title: string,
    seasons: number[],
  ): Promise<AddOutcome> {
    const list = await this.call('/series');
    if (!list.ok) {
      return {
        state: 'unknown',
        detail:
          `"${title}" may already be in Sonarr, but I could not read the library to check ` +
          `its seasons or start a search. (${list.detail})`,
      };
    }
    const rows = Array.isArray(list.body) ? (list.body as Record<string, unknown>[]) : [];
    const row = rows.find((r) => Number(r['tvdbId']) === tvdbId);
    if (!row) {
      return {
        state: 'unknown',
        detail:
          `Sonarr said "${title}" was already added, but I cannot find it by tvdbId ${tvdbId} ` +
          `in the library listing. Check before trying again.`,
      };
    }
    const seriesId = Number(row['id']);
    if (!Number.isFinite(seriesId) || seriesId <= 0) {
      return {
        state: 'unknown',
        detail: `"${title}" is in Sonarr but I could not read its id to search.`,
      };
    }

    const seasonRows = Array.isArray(row['seasons']) ? (row['seasons'] as Record<string, unknown>[]) : [];
    const incomplete: number[] = [];
    const complete: number[] = [];
    for (const n of seasons) {
      const s = seasonRows.find((r) => Number(r['seasonNumber']) === n);
      const stats = (s?.['statistics'] as Record<string, unknown> | undefined) ?? {};
      const have = Number(stats['episodeFileCount'] ?? 0);
      const want = Number(stats['totalEpisodeCount'] ?? stats['episodeCount'] ?? 0);
      if (want > 0 && have >= want) complete.push(n);
      else incomplete.push(n);
    }

    if (incomplete.length === 0) {
      return {
        state: 'already-have',
        detail:
          `"${title}" is already in the library with season(s) ${seasons.join(', ')} on disk — nothing to do.`,
      };
    }

    // Ensure the requested incomplete seasons are monitored, then SeasonSearch.
    // monitorSeasons is the same verb add_season uses; it also flips series.monitored.
    const monitored = await this.monitorSeasons(seriesId, incomplete);
    if (monitored.state === 'unknown') {
      return { state: 'unknown', detail: monitored.detail };
    }
    if (monitored.state === 'failed') {
      return { state: 'failed', detail: monitored.detail };
    }
    if (!monitored.seriesMonitored) {
      return {
        state: 'failed',
        detail:
          `"${title}" season(s) ${monitored.confirmed.join(', ')} switched on, but the SHOW itself ` +
          `came back unmonitored, so Sonarr will grab nothing. Nothing is searching.`,
      };
    }
    const toSearch = monitored.confirmed.length ? monitored.confirmed : incomplete;
    const searched = await this.searchSeasonsAndScout(seriesId, title, toSearch, 'already-in-library');
    if (complete.length && searched.state === 'started') {
      return {
        ...searched,
        detail: `${searched.detail} (season(s) ${complete.join(', ')} already complete on disk.)`,
      };
    }
    return searched;
  }

  /**
   * Queue an explicit SeasonSearch per season, then SAMPLE indexer swarms.
   *
   * 🔴 MONITORING / addOptions.searchForMissingEpisodes ALONE IS NOT ENOUGH.
   * add_season already documents this; add_series must follow the same rule.
   *
   * The scout asks `/release?episodeId=` for one missing episode per season
   * (capped) and ranks by seeders the same way search_episode does. It does NOT
   * auto-grab — grabbing every episode of a new show would bypass the quality
   * profile and hammer indexers. It tells the caller when swarms look dead so
   * Jedd can fall through to find_gaps / search_episode / grab_release.
   */
  private async searchSeasonsAndScout(
    seriesId: number,
    title: string,
    seasons: number[],
    how: 'added' | 'already-in-library',
  ): Promise<AddOutcome> {
    const searched: number[] = [];
    const failed: { season: number; why: string }[] = [];
    for (const n of seasons) {
      const r = await this.seasonSearch(seriesId, n);
      if (r.ok) searched.push(n);
      else failed.push({ season: n, why: r.detail });
    }

    if (searched.length === 0) {
      const why = failed.map((f) => `S${f.season}: ${f.why}`).join('; ');
      return {
        state: 'failed',
        detail:
          how === 'added'
            ? `"${title}" was added and season(s) ${seasons.join(', ')} are monitored, but SeasonSearch ` +
              `failed for every one, so NOTHING is searching. ${why}`
            : `"${title}" is in the library and the seasons were switched on, but SeasonSearch failed ` +
              `for every one, so NOTHING is searching. ${why}`,
      };
    }

    const scout = await this.scoutReleaseHealth(seriesId, searched);
    const partial =
      failed.length > 0
        ? ` Season(s) ${failed.map((f) => f.season).join(', ')} could NOT be searched (${failed
            .map((f) => f.why)
            .join('; ')}).`
        : '';
    const prefix =
      how === 'added'
        ? `"${title}" added; SeasonSearch queued for season(s) ${searched.join(', ')}.`
        : `"${title}" was already in Sonarr; SeasonSearch queued for season(s) ${searched.join(', ')}.`

    return {
      state: 'started',
      detail: `${prefix}${partial}${scout}`,
      confirmed: searched,
    };
  }

  /**
   * One missing episode per season, max three seasons — enough to know whether
   * indexers are offering live swarms without searching the whole show.
   */
  private async scoutReleaseHealth(seriesId: number, seasons: number[]): Promise<string> {
    const eps = await this.episodes(seriesId);
    if (eps.state !== 'episodes') {
      return (
        ' Could not sample indexer releases after search, so I do not know whether seeders look healthy — ' +
        'if downloads stall, use find_gaps / search_episode / grab_release (those pick by seeder health).'
      );
    }
    const notes: string[] = [];
    let anyHealthy = false;
    let anyThin = false;
    let anyDeadOnly = false;
    let anyEmpty = false;
    for (const season of seasons.slice(0, 3)) {
      const missing = eps.rows.find(
        (e) => e.season === season && e.monitored && !e.hasFile && e.episode > 0,
      );
      if (!missing) continue;
      const rel = await this.releasesFor(missing.id);
      if (rel.state !== 'releases') {
        notes.push(`S${season} release scout failed`);
        continue;
      }
      if (rel.rows.length === 0) {
        anyEmpty = true;
        notes.push(`S${season}E${missing.episode}: no indexer releases`);
        continue;
      }
      const withSeeds = rel.rows.filter((r) => r.seeders > 0);
      if (withSeeds.length === 0) {
        anyDeadOnly = true;
        notes.push(`S${season}E${missing.episode}: ${rel.rows.length} release(s), all with NO seeders`);
        continue;
      }
      const best = [...withSeeds].sort((a, b) => b.seeders - a.seeders || b.resolution - a.resolution)[0]!;
      if (best.seeders >= 5) {
        anyHealthy = true;
        notes.push(
          `S${season}E${missing.episode}: best swarm ${best.seeders} seeder(s) (${best.quality}` +
            `${best.approved ? '' : ', outside profile — grab_release can still take it'})`,
        );
      } else {
        anyThin = true;
        notes.push(
          `S${season}E${missing.episode}: best swarm only ${best.seeders} seeder(s) (${best.quality})`,
        );
      }
    }

    if (notes.length === 0) {
      return ' No missing monitored episodes to sample yet (Sonarr may still be refreshing the episode list).';
    }

    let advice = '';
    if (anyDeadOnly || anyEmpty) {
      advice =
        ' If the automatic search stalls or grabs dead torrents, use find_gaps then search_episode / ' +
        'grab_release — those rank by seeder health and can take a release the quality profile refused.';
    } else if (anyThin && !anyHealthy) {
      advice =
        ' Swarms look thin; if a download sits at 0%, unstick it and use search_episode / grab_release ' +
        'to pick a healthier release.';
    }
    return ` Release scout — ${notes.join('; ')}.${advice}`;
  }

  /**
   * Radarr already has this tmdbId. If a file is on disk, that is already-have.
   * If not, queue MoviesSearch — "in Radarr" without a file is still unfinished.
   */
  private async researchExistingMovie(tmdbId: number, title: string): Promise<AddOutcome> {
    const list = await this.call('/movie');
    if (!list.ok) {
      return {
        state: 'unknown',
        detail:
          `"${title}" may already be in Radarr, but I could not read the library to check ` +
          `whether a file is on disk or to start a search. (${list.detail})`,
      };
    }
    const rows = Array.isArray(list.body) ? (list.body as Record<string, unknown>[]) : [];
    const row = rows.find((r) => Number(r['tmdbId']) === tmdbId);
    if (!row) {
      return {
        state: 'unknown',
        detail:
          `Radarr said "${title}" was already added, but I cannot find it by tmdbId ${tmdbId} ` +
          `in the library listing. Check before trying again.`,
      };
    }
    const id = Number(row['id']);
    const hasFile = row['hasFile'] === true;
    if (hasFile) {
      return {
        state: 'already-have',
        detail: `"${title}" is already in the library with a file on disk — nothing to do.`,
      };
    }
    if (!Number.isFinite(id) || id <= 0) {
      return {
        state: 'unknown',
        detail: `"${title}" is in Radarr without a file, but I could not read its id to search.`,
      };
    }
    const search = await this.post('/command', { name: 'MoviesSearch', movieIds: [id] });
    if (search.status === 0) {
      return {
        state: 'unknown',
        detail:
          `"${title}" is already in Radarr with no file, but I could not reach Radarr to ` +
          `start a search. (${search.detail})`,
      };
    }
    if (!search.ok) {
      return {
        state: 'failed',
        detail:
          `"${title}" is already in Radarr with no file, and MoviesSearch was refused ` +
          `(http ${search.status}): ${search.detail.slice(0, 160)}`,
      };
    }
    return {
      state: 'started',
      detail:
        `"${title}" was already in Radarr but has no file yet — searching for a release now.`,
      confirmed: [],
    };
  }

  /** Map an arr response onto the four states. Never collapses them. */
  private interpretAdd(
    res: { ok: boolean; status: number; body: unknown; detail: string },
    seasons: number[],
    title: string,
  ): AddOutcome {
    if (res.ok) {
      return {
        state: 'started',
        detail: `"${title}" added and searching${seasons.length ? ` (season(s) ${seasons.join(', ')})` : ''}.`,
        confirmed: seasons,
      };
    }
    // 🔴 ALREADY PRESENT IS SUCCESS, NOT FAILURE. The arrs answer 400 with a
    // validation error whose text names the collision. Telling the user to retry
    // is the one action guaranteed never to work.
    if (res.status === 400 && /already been added|already exists/i.test(res.detail)) {
      return { state: 'already-have', detail: `"${title}" is already in the library — nothing to do.` };
    }
    if (res.status === 0) {
      return {
        state: 'unknown',
        detail:
          `Could not reach the service adding "${title}", so I do NOT know whether it was added. ` +
          `This is not a "no" — check before trying again. (${res.detail})`,
      };
    }
    /**
     * 🔴 5xx IS UNKNOWN, NOT "REFUSED". Same rule as `monitorSeasons`.
     *
     * A 4xx is the service declining, and "nothing was added" is then true. A
     * 502 from a reverse proxy — or a 500 raised AFTER the add was applied —
     * means it may well have landed, and `Add refused` is a claim we cannot back
     * up. This was reported to users as a refusal by `add_movie` and
     * `add_series` before `add_season` existed; fixed here rather than in the
     * new caller, because the defect lives in the shared component.
     */
    if (res.status >= 500) {
      return {
        state: 'unknown',
        detail:
          `The service answered http ${res.status} adding "${title}". That is a server-side error, ` +
          `not a refusal, so it MAY have been added — check before trying again. (${res.detail.slice(0, 160)})`,
      };
    }
    return { state: 'failed', detail: `Add refused (http ${res.status}): ${res.detail.slice(0, 160)}` };
  }

  /**
   * How far along is something we added? Three-state, like everything else.
   *
   * This is what a `media-add` follow-up goes and looks at, and it must be able
   * to say **"I could not check"** distinctly from **"nothing has arrived"** —
   * the second is news the user needs, the first is not something to report as
   * if it were.
   */
  async progress(
    id: number,
    seasons: number[],
  ): Promise<
    | { state: 'complete'; detail: string }
    | { state: 'partial'; detail: string; have: number; want: number }
    | { state: 'none'; detail: string }
    | { state: 'unknown'; detail: string }
  > {
    const res = await this.call(`/${this.kind}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const rows = Array.isArray(res.body) ? (res.body as Record<string, unknown>[]) : [];
    const idField = this.kind === 'series' ? 'tvdbId' : 'tmdbId';
    const row = rows.find((r) => Number(r[idField]) === id);
    if (!row) {
      return {
        state: 'unknown',
        detail:
          `"${id}" is not in the library listing at all, so I cannot tell whether it was removed, ` +
          'never added, or added under a different id. Not reporting this as "nothing arrived".',
      };
    }
    const title = String(row['title'] ?? id);
    if (this.kind === 'movie') {
      const hasFile = row['hasFile'] === true;
      return hasFile
        ? { state: 'complete', detail: `"${title}" has downloaded.` }
        : { state: 'none', detail: `"${title}" is added but has not downloaded yet.` };
    }
    const all = Array.isArray(row['seasons']) ? (row['seasons'] as Record<string, unknown>[]) : [];
    const wanted = all.filter((se) => seasons.includes(Number(se['seasonNumber'])));
    if (wanted.length === 0) {
      return { state: 'unknown', detail: `could not find season data for "${title}".` };
    }
    let have = 0;
    let want = 0;
    const perSeason: string[] = [];
    for (const se of wanted) {
      const st = (se['statistics'] ?? {}) as Record<string, unknown>;
      const got = Number(st['episodeFileCount'] ?? 0);
      const tot = Number(st['totalEpisodeCount'] ?? 0);
      have += got;
      want += tot;
      perSeason.push(`S${se['seasonNumber']} ${got}/${tot}`);
    }
    const detail = `"${title}": ${perSeason.join(', ')}`;
    if (want > 0 && have >= want) return { state: 'complete', detail };
    if (have > 0) return { state: 'partial', detail, have, want };
    return { state: 'none', detail };
  }

  /**
   * Remove ONE queue row, telling the arr to delete it from the download client
   * and blocklist the release.
   *
   * ── 🔴 THE METHOD IS A LITERAL, AND `call()` IS NOT REUSED ──────────────────
   *
   * `call()` is GET-only by construction — the same discipline as
   * `homelab-read.ts`, where adding a `method` parameter would turn a lookup
   * table into a parser. So the one destructive verb this client has gets its
   * own function with `DELETE` written out, rather than making every existing
   * read one argument away from a delete.
   *
   * ⚠️ `blocklist=true` is what stops the arr immediately re-grabbing the same
   * release. It keys on RELEASE and INDEXER identity, **not on infohash**, so
   * the identical torrent offered by a different indexer walks straight back
   * through it — measured 2026-08-23, a replacement grab re-added the exact
   * infohash blocklisted minutes earlier because LimeTorrents advertised it at
   * 1562 seeders while its real swarm had been 0 for 23 hours. The caller must
   * diff any new infohash against what it removed.
   */
  async removeFromQueue(rowId: number): Promise<{ ok: boolean; detail: string }> {
    const url = `${this.opts.baseUrl}/queue/${rowId}?removeFromClient=true&blocklist=true`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { 'X-Api-Key': this.opts.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status >= 400) {
        return { ok: false, detail: `row ${rowId}: HTTP ${res.status}` };
      }
      return { ok: true, detail: `row ${rowId}: removed` };
    } catch (e) {
      return {
        ok: false,
        // ⚠️ A transport failure on a DELETE is not "it did not happen".
        detail: `row ${rowId}: ${describeError(e, redactUrlSecrets)} — it MAY still have been removed`,
      };
    }
  }

  /**
   * The download queue, grouped into RELEASES.
   *
   * 🔴 THE ONLY SOURCE OF TRUTH FOR "WHAT IS DOWNLOADING". There is deliberately
   * no cache in front of this and no local job store beside it — see
   * `src/media/queue.ts` for why the second source is the defect rather than the
   * staleness.
   *
   * `includeSeries` / `includeMovie` are what put a human-readable SUBJECT on
   * each row. Without them the only title present is the RELEASE name
   * (`Fringe.S02E18.720p.HDTV.X264-DIMENSION`), which a person asking "is Fringe
   * downloading?" would not match.
   *
   * ⚠️ `saturated` is reported rather than swallowed. A truncated queue read
   * looks exactly like a shorter queue, and "fewer things are downloading than
   * you think" is precisely the wrong thing to say by accident.
   */
  async queue(): Promise<
    | { state: 'queue'; releases: Release[]; totalRecords: number; saturated: boolean }
    | { state: 'unknown'; detail: string }
  > {
    const pageSize = 500;
    const include =
      this.kind === 'series'
        ? 'includeUnknownSeriesItems=true&includeSeries=true'
        : 'includeUnknownMovieItems=true&includeMovie=true';
    const res = await this.call(`/queue?pageSize=${pageSize}&${include}`);
    if (!res.ok) return { state: 'unknown', detail: res.detail };
    const total = Number((res.body as { totalRecords?: unknown })?.totalRecords ?? 0);
    return {
      state: 'queue',
      releases: parseQueue(res.body, this.kind === 'series' ? 'sonarr' : 'radarr'),
      totalRecords: Number.isFinite(total) ? total : 0,
      saturated: Number.isFinite(total) && total > pageSize,
    };
  }

  /** Reachability, distinguishing a wrong URL from a dead service. */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    const res = await this.call('/system/status');
    return { reachable: res.ok, detail: res.ok ? 'reachable' : res.detail };
  }
}

/**
 * `seasonNumber -> monitored`, skipping rows without a usable season number.
 *
 * ⚠️ Skipping is the point. `Number(undefined)` is `NaN`, every such row
 * collides on one Map key, and the difference surfaces to a user as
 * "⚠️ SNaN also changed state, which was not asked for" — a blast-radius alarm
 * about a season that does not exist.
 */
function seasonMap(rows: Record<string, unknown>[]): Map<number, boolean> {
  const m = new Map<number, boolean>();
  for (const r of rows) {
    const n = Number(r['seasonNumber']);
    if (!Number.isFinite(n)) continue;
    m.set(n, r['monitored'] === true);
  }
  return m;
}

/**
 * 🔴 ONE WRITER PER SERIES AT A TIME.
 *
 * `monitorSeasons` is a read-modify-write over the WHOLE series object, and the
 * BlueBubbles receiver dispatches inbound messages fire-and-forget — so two
 * turns genuinely overlap. Interleaved, A's PUT is built from a snapshot taken
 * before B's, and it reverts B's season while both calls report success.
 *
 * Chaining per series removes the case we control. It is deliberately NOT a
 * general mutex: it is keyed by base URL + series id, so unrelated shows still
 * proceed in parallel, and it cannot deadlock because nothing takes two.
 */
const seriesLocks = new Map<string, Promise<unknown>>();

async function withSeriesLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = seriesLocks.get(key) ?? Promise.resolve();
  // `.catch` so one failed write does not poison every later one on this series.
  const mine = prior.catch(() => undefined).then(fn);
  seriesLocks.set(key, mine);
  try {
    return await mine;
  } finally {
    if (seriesLocks.get(key) === mine) seriesLocks.delete(key);
  }
}

/**
 * 🔴 THE BREAKER STATE. Per-baseUrl, the timestamp of the last TRANSPORT
 * failure (timeout / ECONNREFUSED / EHOSTUNREACH / ENOTFOUND / …) and the
 * message that came back. HTTP error responses are deliberately not recorded —
 * they mean the service answered, which is a different signal.
 *
 * Keyed on `baseUrl` because that is the only identifier stable across the
 * `ArrClient` instances the tools construct per call. Per-instance state
 * would observe one failure and then be discarded; per-URL state covers the
 * real failure pattern (catalogue_search → add_movie → catalogue_search in
 * one turn), each constructing its own client.
 */
type LastTransportFailure = { at: number; detail: string };
const lastTransportFailure = new Map<string, LastTransportFailure>();
const FAIL_FAST_COOLDOWN_MS = 30_000;

/**
 * Visible for tests: returns the failure that is currently cooling down for a
 * base URL, with the elapsed time, or null if the breaker is closed.
 *
 * `elapsedMs` lets a test assert the message names the right window without
 * reaching for the clock.
 */
export function cooledDownFor(baseUrl: string): { elapsedMs: number; detail: string } | null {
  const f = lastTransportFailure.get(baseUrl);
  if (!f) return null;
  const elapsedMs = Date.now() - f.at;
  if (elapsedMs >= FAIL_FAST_COOLDOWN_MS) {
    // Cooldown elapsed. Drop the entry so a future failure starts a fresh window
    // rather than being measured from the original timestamp.
    lastTransportFailure.delete(baseUrl);
    return null;
  }
  return { elapsedMs, detail: f.detail };
}

/** Visible for tests: forget everything the breaker knows. */
export function resetTransportBreaker(): void {
  lastTransportFailure.clear();
}

function recordTransportFailure(baseUrl: string, detail: string): void {
  lastTransportFailure.set(baseUrl, { at: Date.now(), detail });
}
