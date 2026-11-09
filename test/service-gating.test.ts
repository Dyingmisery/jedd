import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTools } from '../src/tools/index.js';
import { testConfig } from './helpers.js';

/**
 * A TOOL FOR A SERVICE YOU DO NOT RUN IS NOT A FEATURE.
 *
 * Change 2 removed the ssh tools from a deploy with no ssh host. This does the
 * same for the *arr stack, Jellyfin, qBittorrent and Dispatcharr: a stranger
 * with only Ollama and Sonarr should not be offered `add_movie`, because there
 * is no Radarr for it to add to, and the failure would arrive at the moment they
 * asked for a film.
 *
 * ── 🔴 TWO OF THESE CANNOT BE GATED ON THE URL ───────────────────────────────
 *
 * `DISPATCHARR_URL` and `QBITTORRENT_LAN_URL` have NON-EMPTY defaults in
 * `config.ts`, so `if (config.dispatcharr.baseUrl)` is true for somebody who has
 * never heard of Dispatcharr — the gate would never fire and would LOOK correct
 * in review. Availability has to mean "explicitly set", the same distinction
 * `homelabSshConfigured` already draws. The API keys are different: they default
 * to `''`, so truthiness genuinely means configured.
 *
 * ── ⚠️ DISPATCHARR IS GATED ON URL ONLY, DELIBERATELY ────────────────────────
 *
 * Its username/password are unset on the live deployment and it works anyway.
 * Gating on credentials would have silently removed `channel_health` and
 * `livetv_status` from a working install — fixing a publication problem by
 * breaking somebody's setup. Presence of the URL is the signal.
 *
 * ── WHY SOME TOOLS DECLARE NOTHING ───────────────────────────────────────────
 *
 * `check_status`, `catalogue_search` and `library_search` span several services
 * and degrade PARTIALLY: with Sonarr only, "is The Bear downloaded" is still a
 * question they can answer, and "is Dune downloaded" honestly is not. Removing
 * them would delete a working capability to avoid a partial one, which is
 * over-gating — the harm the whole exercise is meant to avoid, pointed the other
 * way.
 */

/** Every service off. The floor: what survives with nothing configured. */
const NONE = {
  sonarr: false,
  radarr: false,
  prowlarr: false,
  jellyfin: false,
  plex: false,
  qbittorrent: false,
  dispatcharr: false,
  audiobookshelf: false,
};

test('🔴 no Radarr: add_movie is not offered', async () => {
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, sonarr: true } }),
  ).map((t) => t.name);
  assert.equal(tools.includes('add_movie'), false, 'offered a film adder with no Radarr to add to');
});

test('CONTROL: with Radarr, add_movie IS offered', async () => {
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, radarr: true } }),
  ).map((t) => t.name);
  assert.equal(tools.includes('add_movie'), true);
});

test('🔴 no Sonarr: the WHOLE TV flow goes, producer and consumer together', async () => {
  // grab_release consumes a choice that search_episode produces. Gating one
  // without the other is the orphan bug; they share a service, so they share a
  // gate by construction rather than by anyone remembering.
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, radarr: true } }),
  ).map((t) => t.name);
  for (const n of ['add_series', 'add_season', 'find_gaps', 'search_episode', 'grab_release']) {
    assert.equal(tools.includes(n), false, `${n} survived with no Sonarr`);
  }
});

test('CONTROL: with Sonarr the whole TV flow is present', async () => {
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, sonarr: true } }),
  ).map((t) => t.name);
  for (const n of ['add_series', 'add_season', 'find_gaps', 'search_episode', 'grab_release']) {
    assert.equal(tools.includes(n), true, `${n} missing though Sonarr is configured`);
  }
});

test('🔴 no Prowlarr: search_audiobook and indexer_admin are not offered', async () => {
  const tools = buildTools(testConfig({ readOnly: false, services: { ...NONE } })).map((t) => t.name);
  assert.equal(tools.includes('search_audiobook'), false);
  assert.equal(tools.includes('indexer_admin'), false);
});

test('🔴 no Jellyfin: jellyfin_sessions is not offered', async () => {
  const tools = buildTools(testConfig({ readOnly: false, services: { ...NONE } })).map((t) => t.name);
  assert.equal(tools.includes('jellyfin_sessions'), false);
});

test('🔴 no qBittorrent: stuck_downloads is not offered', async () => {
  const tools = buildTools(testConfig({ readOnly: false, services: { ...NONE } })).map((t) => t.name);
  assert.equal(tools.includes('stuck_downloads'), false);
});

/**
 * 🔴 THE GATE MUST NOT BE SATISFIED BY A DEFAULT.
 *
 * This is the case that would pass review while doing nothing: if availability
 * were read off `config.dispatcharr.baseUrl`, its non-empty default would make
 * every deployment look configured.
 */
test('🔴 no Dispatcharr: channel_health and livetv_status go, even though baseUrl is non-empty', async () => {
  const cfg = testConfig({
    readOnly: false,
    homelabSshConfigured: true,
    services: { ...NONE, dispatcharr: false },
  });
  assert.notEqual(cfg.dispatcharr.baseUrl, '', 'precondition: the default really is non-empty');
  const tools = buildTools(cfg, { safe: true, reason: '', evidence: [] }).map((t) => t.name);
  assert.equal(tools.includes('channel_health'), false);
  assert.equal(tools.includes('livetv_status'), false);
});

test('CONTROL: Dispatcharr configured by URL ALONE is enough — no credentials needed', async () => {
  // The live deployment runs exactly this way. If this ever fails, somebody has
  // gated Dispatcharr on credentials and just deleted two working tools.
  const cfg = testConfig({
    readOnly: false,
    homelabSshConfigured: true,
    dispatcharr: { baseUrl: 'http://dispatcharr.invalid:9191' },
    services: { ...NONE, dispatcharr: true },
  });
  const tools = buildTools(cfg, { safe: true, reason: '', evidence: [] }).map((t) => t.name);
  assert.equal(tools.includes('channel_health'), true, 'gated on credentials it does not need');
  assert.equal(tools.includes('livetv_status'), true);
});

test('tools that degrade PARTIALLY are not over-gated away', async () => {
  // With one arr, a cross-service tool can still answer half the questions.
  // Deleting it would remove a working capability to avoid a partial one.
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, sonarr: true } }),
  ).map((t) => t.name);
  for (const n of ['check_status', 'catalogue_search', 'resolve_choice']) {
    assert.equal(tools.includes(n), true, `${n} was over-gated`);
  }
});

/**
 * ── "PARTIAL" NEEDS SOMETHING TO BE PARTIAL *OF* ─────────────────────────────
 *
 * `check_status`, `catalogue_search` and `library_search` deliberately do not
 * declare `needsServices`, because with Sonarr alone they still answer half the
 * questions. But that argument evaporates at zero: with NO *arr configured there
 * is no half to answer, and they are back to being registered-and-broken — the
 * exact shape this file exists to remove.
 *
 * So they declare `needsAnyService` instead: present if AT LEAST ONE of the
 * named services exists, absent only when none do. ALL-semantics would
 * over-gate them; no semantics at all under-gates the empty case.
 */
test('🔴 with NO *arr at all, the cross-service tools go too', async () => {
  const tools = buildTools(testConfig({ readOnly: false, services: { ...NONE } })).map((t) => t.name);
  for (const n of ['check_status', 'catalogue_search', 'library_search', 'homelab_read']) {
    assert.equal(tools.includes(n), false, `${n} has nothing to read with zero services configured`);
  }
});

test('CONTROL: ONE service is enough to keep them — partial beats absent', async () => {
  const tools = buildTools(
    testConfig({ readOnly: false, services: { ...NONE, sonarr: true } }),
  ).map((t) => t.name);
  for (const n of ['check_status', 'catalogue_search', 'library_search', 'homelab_read']) {
    assert.equal(tools.includes(n), true, `${n} was over-gated — one service is enough`);
  }
});
