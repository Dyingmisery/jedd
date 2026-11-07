import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATEGORY,
  ProwlarrClient,
  isValidInfoHash,
  magnetFor,
  rankReleases,
  resolveMagnet,
  type FetchImpl,
} from '../src/media/prowlarr.js';

const HASH = 'a'.repeat(40);
const json = (b: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => b }) as Response;

const client = (impl: FetchImpl) =>
  new ProwlarrClient({ baseUrl: 'http://p.invalid', apiKey: 'k', fetchImpl: impl });

// ── 🔴 the infoHash is the whole point ───────────────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THIS TEST USED TO ASSERT THE OPPOSITE, AND THE PREMISE WAS FALSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It read: *"a release with no infoHash is DISCARDED, not offered"*, reasoning
 * that qBittorrent lives in gluetun's netns and cannot reach Prowlarr, so a
 * release we can only name by URL is a choice the user cannot have.
 *
 * **The reasoning is still true and the conclusion was wrong.** The
 * `downloadUrl` is a 301 to a MAGNET, and reading a redirect is something this
 * process does — qBittorrent is never asked to. Measured 2026-09-04: every
 * 1337x row publishes no `infoHash`, and 8 of 8 redirected to a magnet carrying
 * a valid hash and 21 trackers.
 *
 * What it cost: Dungeon Crawler Carl is carried ONLY by 1337x, so the entire
 * series was invisible and the tool truthfully reported that nothing could be
 * fetched. The old assertion was pinning that behaviour in place.
 *
 * ⚠️ The RULE it was protecting survives, narrowed: we still refuse to offer a
 * release nobody can take. A row with neither an infoHash nor a download link is
 * still discarded — see the test below this one.
 */
test('🔴 a release with no infoHash but a download link is OFFERED, to be resolved later', async () => {
  const r = await client(async () =>
    json([{ title: 'A Book', downloadUrl: 'http://prowlarr/proxy/1', seeders: 9 }]),
  ).search('a book', CATEGORY.ebook);
  assert.equal(r.state, 'results');
  if (r.state !== 'results') throw new Error('unreachable');
  assert.equal(r.releases.length, 1);
  assert.equal(r.releases[0]!.infoHash, '', 'not resolved yet, and it says so by being empty');
  assert.equal(r.releases[0]!.downloadUrl, 'http://prowlarr/proxy/1');
  assert.equal(r.discarded, 0);
});

test('🔴 a release with NEITHER an infoHash nor a download link is still discarded', async () => {
  const r = await client(async () => json([{ title: 'A Book', seeders: 9 }])).search('a book', CATEGORY.ebook);
  assert.equal(r.state, 'none');
  if (r.state !== 'none') throw new Error('unreachable');
  assert.match(r.detail, /none carried an infoHash OR a download link/);
});

test('discarded-but-present is distinguishable from genuinely-nothing', async () => {
  const nothing = await client(async () => json([])).search('x', CATEGORY.ebook);
  assert.equal(nothing.state, 'none');
  if (nothing.state !== 'none') throw new Error('unreachable');
  assert.match(nothing.detail, /found nothing/);
});

test('🔴 an infoHash must be exactly 40 hex characters', () => {
  // It is interpolated into a shell command on the PRIVILEGED ssh identity, so
  // this validation is the entire defence -- same as isValidContainerName.
  assert.equal(isValidInfoHash(HASH), true);
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)};rm -rf /`, 'g'.repeat(40), '', null]) {
    assert.equal(isValidInfoHash(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('🔴 magnetFor REFUSES to build from anything unvalidated', () => {
  assert.throws(() => magnetFor('not-a-hash', 'x'), /refusing to build a magnet/);
  assert.throws(() => magnetFor(`${'a'.repeat(40)} && curl evil`, 'x'));
  assert.match(magnetFor(HASH, 'A Book'), /^magnet:\?xt=urn:btih:a{40}&dn=A%20Book$/);
});

// ── 🔴 a failure to look is not a finding ────────────────────────────────────

test('🔴 an unreachable Prowlarr is UNKNOWN, never "nothing found"', async () => {
  const r = await client(async () => {
    throw new Error('ETIMEDOUT');
  }).search('x', CATEGORY.ebook);
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /NOT a finding that nothing exists/);
});

test('an http error and a non-JSON body are both UNKNOWN', async () => {
  assert.equal((await client(async () => json(null, 500)).search('x', 7020)).state, 'unknown');
  assert.equal(
    (
      await client(async () =>
        ({ ok: true, status: 200, json: async () => { throw new Error('nope'); } }) as unknown as Response,
      ).search('x', 7020)
    ).state,
    'unknown',
  );
});

// ── the search itself ────────────────────────────────────────────────────────

test('the ebook category and the api key are sent, and the call is bounded', async () => {
  let url = '';
  let init: RequestInit | undefined;
  await client(async (u, i) => {
    url = String(u);
    init = i;
    return json([]);
  }).search('the anxious generation', CATEGORY.ebook);
  // 🔴 Prowlarr has NO path prefix, so /api/v1 is appended by the client.
  assert.match(url, /^http:\/\/p\.invalid\/api\/v1\/search\?/, 'bare root + /api/v1');
  assert.match(url, /categories=7020/);
  assert.match(url, /query=the%20anxious%20generation/);
  assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'k');
  assert.ok(init?.signal, 'a cold search takes 35-45s but it still must be bounded');
});

test('🔴 exactly ONE request is made — no retry loop', async () => {
  // Repeated searches trip per-indexer failure-backoff, which temporarily
  // DISABLES indexers. A retry loop degrades the thing it retries against.
  let calls = 0;
  await client(async () => {
    calls += 1;
    throw new Error('slow');
  }).search('x', CATEGORY.ebook);
  assert.equal(calls, 1);
});

// ── ranking ──────────────────────────────────────────────────────────────────

test('alive releases outrank dead ones, then by seeders', () => {
  const mk = (title: string, seeders: number) => ({
    title, protocol: 'torrent' as const, seeders, infoHash: HASH, sizeBytes: 1, indexer: 'i',
  });
  const ranked = rankReleases([mk('dead', 0), mk('few', 3), mk('many', 40)]);
  assert.deepEqual(ranked.map((r) => r.title), ['many', 'few', 'dead']);
});

// ── 🔴 audiobook ranking: preference is a parameter, classification is not ───

import { classifyAudiobook, rankAudiobooks } from '../src/media/prowlarr.js';

const ab = (title: string, seeders = 10) => ({
  title, protocol: 'torrent' as const, seeders, infoHash: HASH, sizeBytes: 1, indexer: 'i',
});

test('🔴 "unabridged" is NOT classified as abridged — it contains the word', () => {
  // The \bn't\b trap in a new costume, and worse: a substring rather than a
  // contraction. Every unabridged release would otherwise be demoted.
  assert.equal(classifyAudiobook('Dune [Unabridged]').abridged, false);
  assert.equal(classifyAudiobook('Dune [Abridged]').abridged, true);
});

test('🔴 the GraphicAudio PREFERENCE is a parameter, never mined from text', () => {
  // V1 regexed the whole session INCLUDING Jedd's own turns, so "no, NOT the
  // graphic audio version" turned it ON, and Jedd's own listing then re-asserted
  // it for the rest of the window.
  const list = [ab('Dune GraphicAudio'), ab('Dune Unabridged')];
  assert.match(rankAudiobooks(list, { wantGraphicAudio: false })[0]!.title, /Unabridged/);
  assert.match(rankAudiobooks(list, { wantGraphicAudio: true })[0]!.title, /GraphicAudio/);
});

test('a dead release never outranks a live one, whatever else matches', () => {
  const list = [ab('Dune GraphicAudio', 0), ab('Dune plain', 5)];
  assert.equal(rankAudiobooks(list, { wantGraphicAudio: true })[0]!.title, 'Dune plain');
});

test('unabridged beats abridged when neither is preferred by name', () => {
  const list = [ab('Dune Abridged'), ab('Dune Unabridged')];
  assert.match(rankAudiobooks(list, { wantGraphicAudio: false })[0]!.title, /Unabridged/);
});


// ── 🔴 resolveMagnet: the 301 IS the payload ────────────────────────────────

/** A Response carrying only what `resolveMagnet` reads. */
const redirect = (location: string | null, status = 301): Response =>
  ({ ok: false, status, headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) } }) as unknown as Response;

const REAL_MAGNET =
  'magnet:?xt=urn:btih:F1A841C4EB55D2ECEEBDCAB876724BBF1A99CC8E&dn=The+Dungeon+Anarchists+Cookbook' +
  '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce';

test('🔴 resolveMagnet reads the magnet out of the redirect, hash and trackers intact', async () => {
  // The verbatim redirect target measured 2026-09-04 for DCC book 03.
  const r = await resolveMagnet('http://prowlarr/proxy/1', async () => redirect(REAL_MAGNET));
  assert.equal(r.state, 'magnet');
  if (r.state !== 'magnet') throw new Error('unreachable');
  assert.equal(r.infoHash, 'F1A841C4EB55D2ECEEBDCAB876724BBF1A99CC8E');
  assert.match(r.magnetUri, /tracker\.opentrackr\.org/, 'the trackers are the reason to prefer this over a built magnet');
});

test('🔴 resolveMagnet asks for the redirect and does NOT follow it', async () => {
  // Following it throws: the target scheme is `magnet:`, which no HTTP client
  // can fetch. `redirect: manual` is load bearing, not a style choice.
  let seen: RequestInit | undefined;
  await resolveMagnet('http://prowlarr/proxy/1', async (_u, init) => {
    seen = init;
    return redirect(REAL_MAGNET);
  });
  assert.equal(seen?.redirect, 'manual');
});

test('🔴 a Location that is not a magnet, or carries a bad hash, is UNKNOWN not a grab', async () => {
  for (const [loc, why] of [
    [null, 'no redirect at all'],
    ['https://example.invalid/somewhere', 'redirected somewhere that is not a magnet'],
    ['magnet:?xt=urn:btih:nothex&dn=x', 'a hash that is not 40 hex'],
    [`magnet:?xt=urn:btih:${'a'.repeat(39)}`, 'a hash one character short'],
  ] as const) {
    const r = await resolveMagnet('http://prowlarr/proxy/1', async () => redirect(loc));
    assert.equal(r.state, 'unknown', `${why} must not produce a magnet`);
  }
});

test('🔴 an unreachable Prowlarr is UNKNOWN — a failure to LOOK is not a "no"', async () => {
  const r = await resolveMagnet('http://prowlarr/proxy/1', async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(r.state, 'unknown');
  if (r.state !== 'unknown') throw new Error('unreachable');
  assert.match(r.detail, /ECONNREFUSED/);
});
