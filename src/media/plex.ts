/**
 * Read-only Plex library check. Availability is an exact external id plus a
 * real media file, never a title hit and never an arr import.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface PlexEpisode {
  /** ISO date, or null when Plex has no air date. */
  airedAt: string | null;
  hasFile: boolean;
}

export interface PlexSeason {
  seasonNumber: number;
  episodes: PlexEpisode[];
}

export type PlexView =
  | { state: 'ready' }
  | { state: 'not-ready' }
  | { state: 'unconfigured' }
  | { state: 'unknown' };

/**
 * A requested season is ready when every episode that has already aired has a
 * file. Episodes with a future air date do not count. A season with no aired
 * episodes yet is not ready.
 */
export function seasonsReady(requested: number[], seasons: PlexSeason[], now: Date): boolean {
  if (requested.length === 0) return false;
  for (const n of requested) {
    const season = seasons.find((s) => s.seasonNumber === n);
    if (!season) return false;
    const due = season.episodes.filter((ep) => !isFuture(ep.airedAt, now));
    if (due.length === 0) return false;
    if (due.some((ep) => !ep.hasFile)) return false;
  }
  return true;
}

function isFuture(airedAt: string | null, now: Date): boolean {
  if (!airedAt) return false;
  const t = Date.parse(airedAt);
  return Number.isFinite(t) && t > now.getTime();
}

export interface PlexQuery {
  arr: 'movie' | 'series';
  /** tmdb id for a movie, tvdb id for a series. */
  id: number;
  seasons: number[];
  now: Date;
}

export interface PlexChecker {
  available(query: PlexQuery): Promise<PlexView>;
}

interface Meta {
  guids: string[];
  hasFile: boolean;
  seasons: PlexSeason[];
}

export class PlexClient implements PlexChecker {
  constructor(
    private readonly opts: { baseUrl: string; token: string; fetchImpl?: FetchImpl; timeoutMs?: number },
  ) {}

  async available(query: PlexQuery): Promise<PlexView> {
    const found = await this.inspect(query);
    if (found.state === 'unconfigured' || found.state === 'unknown') return { state: found.state };
    if (found.state === 'absent' || found.state === 'movie') {
      return { state: found.state === 'movie' && found.hasFile ? 'ready' : 'not-ready' };
    }
    if (query.seasons.length === 0) return { state: 'not-ready' };
    const ready = query.seasons.every(
      (n) => found.seasons.find((s) => s.seasonNumber === n)?.status === 'ready',
    );
    return { state: ready ? 'ready' : 'not-ready' };
  }

  /**
   * Exact id plus files. A title hit is `absent`. A transport or HTTP failure
   * is `unknown`, which is not the same sentence as "not on Plex".
   */
  async inspect(query: PlexQuery): Promise<PlexInspect> {
    if (!this.opts.baseUrl.trim() || !this.opts.token.trim()) return { state: 'unconfigured' };
    try {
      const sections = await this.getJson('/library/sections');
      const want = query.arr === 'movie' ? 'movie' : 'show';
      for (const dir of containerOf(sections)) {
        if (String(dir['type'] ?? '') !== want) continue;
        const key = String(dir['key'] ?? '');
        if (!key) continue;
        const listed = await this.getJson(`/library/sections/${encodeURIComponent(key)}/all?includeGuids=1`);
        for (const row of metadataRows(listed)) {
          const meta = readMeta(row);
          if (!guidMatches(meta.guids, query.arr, query.id)) continue;
          if (query.arr === 'movie') return { state: 'movie', hasFile: meta.hasFile };
          const ratingKey = String(row['ratingKey'] ?? '');
          const leaves = ratingKey
            ? seasonsFromLeaves(metadataRows(await this.getJson(`/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`)))
            : [];
          return { state: 'series', seasons: seasonVerdicts(leaves, query.seasons, query.now) };
        }
      }
      return { state: 'absent' };
    } catch {
      return { state: 'unknown' };
    }
  }

  /**
   * Token stays on the header. A redirect is followed only when it stays on
   * the same origin, so the token is not sent to some other host.
   */
  private async getJson(path: string): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? ((u, i) => fetch(u, i));
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const root = this.opts.baseUrl.replace(/\/+$/, '');
    let current = `${root}${path}`;
    const origin = new URL(root).origin;
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetchImpl(current, {
        headers: { Accept: 'application/json', 'X-Plex-Token': this.opts.token },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.('location') ?? '';
        const next = new URL(loc, current);
        if (next.origin !== origin) throw new Error('redirect left the plex host');
        current = next.toString();
        continue;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    }
    throw new Error('too many redirects');
  }
}

export function plexFromConfig(plex: { baseUrl: string; token: string }): PlexChecker | undefined {
  return plexCheckerFor(plex);
}

export function plexCheckerFor(
  plex: { baseUrl: string; token: string },
  fetchImpl?: FetchImpl,
): PlexClient | undefined {
  if (!plex.baseUrl.trim() || !plex.token.trim()) return undefined;
  return new PlexClient({ ...plex, ...(fetchImpl ? { fetchImpl } : {}) });
}

function containerOf(body: unknown): Record<string, unknown>[] {
  const root = (body as { MediaContainer?: { Directory?: unknown } } | null)?.MediaContainer;
  const dirs = root?.Directory;
  return Array.isArray(dirs) ? (dirs as Record<string, unknown>[]) : [];
}

function metadataRows(body: unknown): Record<string, unknown>[] {
  const root = (body as { MediaContainer?: { Metadata?: unknown } } | null)?.MediaContainer;
  const rows = root?.Metadata;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function seasonsFromLeaves(rows: Record<string, unknown>[]): PlexSeason[] {
  const bySeason = new Map<number, PlexEpisode[]>();
  for (const row of rows) {
    const n = Number(row['parentIndex'] ?? row['parentSeasonIndex'] ?? row['seasonNumber'] ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const episodes = bySeason.get(n) ?? [];
    episodes.push({
      airedAt: typeof row['originallyAvailableAt'] === 'string' ? row['originallyAvailableAt'] : null,
      hasFile: partExists(row),
    });
    bySeason.set(n, episodes);
  }
  return [...bySeason.entries()].map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }));
}

function partExists(row: Record<string, unknown>): boolean {
  const media = Array.isArray(row['Media']) ? (row['Media'] as Record<string, unknown>[]) : [];
  return media.some((m) => Array.isArray(m['Part']) && (m['Part'] as unknown[]).length > 0);
}

function readMeta(row: Record<string, unknown>): Meta {
  const guids: string[] = [];
  const guidRows = Array.isArray(row['Guid']) ? (row['Guid'] as Record<string, unknown>[]) : [];
  for (const g of guidRows) {
    if (typeof g['id'] === 'string') guids.push(g['id']);
  }
  if (typeof row['guid'] === 'string') guids.push(row['guid']);
  return { guids, hasFile: partExists(row), seasons: [] };
}

function guidMatches(guids: string[], arr: 'movie' | 'series', id: number): boolean {
  const needles = arr === 'movie'
    ? [`tmdb://${id}`, `com.plexapp.agents.themoviedb://${id}`]
    : [`tvdb://${id}`, `com.plexapp.agents.thetvdb://${id}`];
  return guids.some((g) => needles.some((n) => g === n || g.startsWith(`${n}?`)));
}

export function availabilityLine(title: string, arr: 'movie' | 'series', seasons: number[]): string {
  if (arr === 'movie' || seasons.length === 0) return `${title} is now available on Plex.`;
  const nums = [...seasons].sort((a, b) => a - b);
  if (nums.length === 1) return `Season ${nums[0]} of ${title} is now available on Plex.`;
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1).join(', ');
  return `Seasons ${head} and ${last} of ${title} are now available on Plex.`;
}

export function addedLine(title: string, year: number | undefined, arr: 'movie' | 'series', seasons: number[]): string {
  const when = year ? ` (${year})` : '';
  if (arr === 'series' && seasons.length === 1) {
    return `Your request for ${title}${when}, season ${seasons[0]}, has been added.`;
  }
  if (arr === 'series' && seasons.length > 1) {
    const nums = [...seasons].sort((a, b) => a - b);
    return `Your request for ${title}${when}, seasons ${nums.join(', ')}, has been added.`;
  }
  return `Your request for ${title}${when} has been added.`;
}

export function confirmLine(
  options: { arr: 'movie' | 'series'; title?: string; year?: number; network?: string }[],
  purpose: 'add' | 'check' = 'add',
): string {
  const films = options.some((o) => o.arr === 'movie');
  const shows = options.some((o) => o.arr === 'series');
  const which = films && shows ? 'movie or show' : shows ? 'show' : 'movie';
  const lines = options.map((o, i) => {
    const year = o.year ? ` (${o.year})` : '';
    const network = o.network ? ` — ${o.network}` : '';
    const kind = o.arr === 'series' ? 'show' : 'movie';
    return `${i + 1}. ${o.title ?? 'Untitled'}${year}${network} — ${kind}`;
  });
  const ask = purpose === 'check'
    ? `Please confirm which ${which} you'd like me to check on Plex.`
    : `Please confirm which ${which} you'd like to add.`;
  return `${ask}\n${lines.join('\n')}`;
}

export type SeasonStatus = 'ready' | 'missing' | 'unaired';

export interface SeasonVerdict {
  seasonNumber: number;
  status: SeasonStatus;
}

export type PlexInspect =
  | { state: 'unconfigured' }
  | { state: 'unknown' }
  | { state: 'absent' }
  | { state: 'movie'; hasFile: boolean }
  | { state: 'series'; seasons: SeasonVerdict[] };

function seasonVerdicts(seasons: PlexSeason[], requested: number[], now: Date): SeasonVerdict[] {
  const numbers = new Set<number>([...seasons.map((s) => s.seasonNumber), ...requested]);
  return [...numbers]
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .map((n) => {
      const season = seasons.find((s) => s.seasonNumber === n);
      if (!season || season.episodes.length === 0) return { seasonNumber: n, status: 'missing' };
      const due = season.episodes.filter((ep) => !isFuture(ep.airedAt, now));
      if (due.length === 0) return { seasonNumber: n, status: 'unaired' };
      return { seasonNumber: n, status: due.every((ep) => ep.hasFile) ? 'ready' : 'missing' };
    });
}

export function titled(title: string, year?: number): string {
  return year && year > 0 ? `${title} (${year})` : title;
}

/** What a person is told. A series is never called on Plex without a season. */
export function plexStatusLine(
  title: string,
  year: number | undefined,
  found: PlexInspect,
  seasons: number[] = [],
): string {
  const name = titled(title, year);
  if (found.state === 'unconfigured') return 'I cannot check Plex from here.';
  if (found.state === 'unknown') return `I couldn't confirm whether ${name} is on Plex.`;
  if (found.state === 'absent') return `${name} is not on Plex.`;
  if (found.state === 'movie') return found.hasFile ? `${name} is on Plex.` : `${name} is not on Plex.`;
  const asked = seasons.length > 0;
  const rows = asked
    ? seasons.map((n) => found.seasons.find((s) => s.seasonNumber === n) ?? { seasonNumber: n, status: 'missing' as const })
    : found.seasons.filter((s) => s.status !== 'unaired');
  if (!asked && found.seasons.length > 0 && found.seasons.every((s) => s.status === 'unaired')) {
    return `${name} has not aired yet, so I will not call it on Plex.`;
  }
  if (rows.length === 1 && rows[0]!.status === 'unaired') {
    return `Season ${rows[0]!.seasonNumber} of ${name} has not aired yet, so I will not call it on Plex.`;
  }
  const ready = rows.filter((s) => s.status === 'ready').map((s) => s.seasonNumber);
  const missing = rows.filter((s) => s.status === 'missing').map((s) => s.seasonNumber);
  const unaired = rows.filter((s) => s.status === 'unaired').map((s) => s.seasonNumber);
  const parts: string[] = [];
  if (ready.length === 1) parts.push(`Season ${ready[0]} of ${name} is on Plex.`);
  if (ready.length > 1) parts.push(`${seasonPhrase(ready)} of ${name} are on Plex.`);
  if (missing.length === 1) parts.push(`Season ${missing[0]} of ${name} is not on Plex.`);
  if (missing.length > 1) parts.push(`${seasonPhrase(missing)} of ${name} are not on Plex.`);
  if (unaired.length === 1) parts.push(`Season ${unaired[0]} of ${name} has not aired yet.`);
  if (unaired.length > 1) parts.push(`${seasonPhrase(unaired)} of ${name} have not aired yet.`);
  if (parts.length === 0) return `${name} is not on Plex.`;
  return parts.join(' ');
}

function seasonPhrase(nums: number[]): string {
  const n = [...nums].sort((a, b) => a - b);
  if (n.length === 1) return `Season ${n[0]}`;
  return `Seasons ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}
