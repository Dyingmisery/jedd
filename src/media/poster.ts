/**
 * Poster URLs that come back on an arr lookup.
 *
 * `remoteUrl` / `remotePoster` are the external artwork address.
 * `url` is a local cover path and is never used here.
 */

const ALLOWED_HOSTS = new Set(['image.tmdb.org', 'artworks.thetvdb.com']);

export const MAX_POSTER_BYTES = 2_000_000;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export function posterRemoteUrl(row: Record<string, unknown>): string | undefined {
  const top = typeof row['remotePoster'] === 'string' ? row['remotePoster'].trim() : '';
  if (allowedPosterUrl(top)) return top;
  const images = Array.isArray(row['images']) ? row['images'] : [];
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const rec = img as Record<string, unknown>;
    const cover = String(rec['coverType'] ?? '').toLowerCase();
    if (cover !== 'poster') continue;
    const remote = typeof rec['remoteUrl'] === 'string' ? rec['remoteUrl'].trim() : '';
    if (allowedPosterUrl(remote)) return remote;
  }
  return undefined;
}

/** HTTPS on an allowlisted artwork host, with no userinfo. */
export function allowedPosterUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (/[?&](?:api_?key)=/i.test(url.search)) return false;
  return ALLOWED_HOSTS.has(url.hostname);
}

/**
 * Download one poster. Redirects are followed only when the next hop is still
 * allowlisted. No arr API key is attached. A failure is null, never a throw.
 */
export async function fetchAllowlistedPoster(
  raw: string,
  fetchImpl: FetchImpl,
  maxBytes = MAX_POSTER_BYTES,
): Promise<Buffer | null> {
  let current = raw;
  if (!allowedPosterUrl(current)) return null;
  for (let hop = 0; hop < 3; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, { method: 'GET', redirect: 'manual', headers: { Accept: 'image/*' } });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location') ?? '';
      if (!loc) return null;
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return null;
      }
      if (!allowedPosterUrl(next)) return null;
      current = next;
      continue;
    }
    if (!res.ok) return null;
    const declared = Number(res.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.length === 0 || bytes.length > maxBytes) return null;
    return bytes;
  }
  return null;
}
