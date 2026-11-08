import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { FollowupStore, MAX_ATTEMPTS } from '../src/followups.js';
import { runDueFollowups } from '../src/followup-runner.js';
import { resetTransportBreaker } from '../src/media/arr.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. The followup runner re-reads
 * Sonarr/Radarr with the same base URLs the whole test process uses, and a
 * prior test that triggered a transport failure would otherwise be observed
 * here as "the breaker is open" rather than "Sonarr answered with X".
 */
beforeEach(() => {
  resetTransportBreaker();
});

/**
 * "The user learns the outcome" — the defining requirement of the write path.
 *
 * The live case: a GUEST asked for Peppa Pig seasons 1-3 on 2026-04-02. The add
 * was real. Five months later S2 and S3 have zero files and the user was told
 * nothing. Every test here is about the telling, not the adding.
 */

const GUEST = '+18015550188';
const OWNER = '+18015550123';

function store(): FollowupStore {
  return new FollowupStore(join(mkdtempSync(join(tmpdir(), 'jedd-mf-')), 'f.jsonl'));
}

function schedule(s: FollowupStore, handle: string, seasons = [1, 2, 3]) {
  return s.schedule({
    kind: 'media-add',
    senderHandle: handle,
    dueAt: new Date(Date.now() - 1000),
    reason: 'added Peppa Pig seasons 1-3',
    observed: 'add accepted by Sonarr',
    subject: { arr: 'series', id: 73244, title: 'Peppa Pig', seasons },
  });
}

/** A Sonarr /series listing with the given per-season file counts. */
function library(counts: Record<number, [number, number]>) {
  return async () =>
    ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            title: 'Peppa Pig',
            tvdbId: 73244,
            seasons: Object.entries(counts).map(([n, [got, tot]]) => ({
              seasonNumber: Number(n),
              statistics: { episodeFileCount: got, totalEpisodeCount: tot },
            })),
          },
        ]),
    }) as Response;
}

async function run(handle: string, fetchImpl: typeof fetch, counts?: Record<number, [number, number]>) {
  const s = store();
  schedule(s, handle);
  const sent: { to: string; text: string }[] = [];
  const cfg = testConfig({ ownerHandle: OWNER });
  const orig = globalThis.fetch;
  globalThis.fetch = (counts ? library(counts) : fetchImpl) as typeof fetch;
  try {
    const out = await runDueFollowups(s, {
      config: cfg,
      send: async (to, text) => {
        sent.push({ to, text });
      },
    });
    return { out, sent, s };
  } finally {
    globalThis.fetch = orig;
  }
}

// ── 🔴 the guest must be told about their OWN request ────────────────────────

test('🔴 a GUEST is told the outcome of their own media request', async () => {
  // The owner-only speak rule is right for homelab follow-ups and would
  // REPRODUCE the exact defect here: the live Peppa Pig case was a guest, and a
  // follow-up that silently declines to speak is indistinguishable from never
  // following up at all.
  const { sent } = await run(GUEST, null as never, { 1: [52, 52], 2: [52, 52], 3: [52, 52] });
  assert.equal(sent.length, 1, 'the guest who asked must hear back');
  assert.equal(sent[0]?.to, GUEST);
  assert.match(sent[0]!.text, /cannot check Plex/i);
  assert.doesNotMatch(sent[0]!.text, /available on Plex/i);
});

test('CONTROL: the owner is also told — the guest rule did not replace the owner one', async () => {
  const { sent } = await run(OWNER, null as never, { 1: [52, 52], 2: [52, 52], 3: [52, 52] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, OWNER);
});

// ── 🔴 nothing arrived is NEWS, not silence ──────────────────────────────────

test('🔴 PEPPA PIG, exactly as it really is: S1 complete, S2/S3 empty — the user is TOLD', async () => {
  // The real live shape, checked against Sonarr today: S1 52/52, S2 0/52,
  // S3 0/52. That is the PARTIAL branch, not the empty one -- the requested
  // seasons are the ones that silently failed, while an unrequested one landed.
  // It defers while there is still hope, then speaks rather than going quiet.
  const s = store();
  schedule(s, GUEST);
  const sent: { to: string; text: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = library({ 1: [52, 52], 2: [0, 52], 3: [0, 52] }) as typeof fetch;
  try {
    let last;
    // Drive it past its deferral budget, as real time would.
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      for (const f of s.all()) if (f.status === 'pending') f.dueAt = new Date(Date.now() - 1000).toISOString();
      const r = await runDueFollowups(s, {
        config: testConfig({ ownerHandle: OWNER }),
        send: async (to, text) => {
          sent.push({ to, text });
        },
      });
      // The loop runs one tick past resolution, and a resolved follow-up is no
      // longer due -- so keep the last tick that actually DID something.
      if (r.length) last = r;
    }
    assert.ok(sent.length >= 1, 'it must speak rather than going quiet');
    assert.match(sent[0]!.text, /S2 0\/52/, 'and say what it actually saw');
    assert.match(sent[0]!.text, /Some of it arrived and the rest has not/i);
    assert.equal(last?.[0]?.action, 'abandoned');
  } finally {
    globalThis.fetch = orig;
  }
});

test('partial progress is reported as partial, not as complete', async () => {
  const s = store();
  schedule(s, GUEST);
  const orig = globalThis.fetch;
  globalThis.fetch = library({ 1: [52, 52], 2: [10, 52], 3: [0, 52] }) as typeof fetch;
  try {
    const out = await runDueFollowups(s, {
      config: testConfig({ ownerHandle: OWNER }),
      send: async () => {},
    });
    assert.equal(out[0]?.action, 'deferred');
    assert.match(out[0]!.detail, /partial/);
  } finally {
    globalThis.fetch = orig;
  }
});

// ── 🔴 cannot check is not "nothing arrived" ─────────────────────────────────

test('🔴 an unreachable arr NEVER reports as "nothing downloaded"', async () => {
  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const { out, sent } = await run(GUEST, dead);
  assert.equal(out[0]?.action, 'deferred', 'it defers rather than reporting an absence it did not observe');
  assert.equal(sent.length, 0);
});

test('a title missing from the library entirely is UNKNOWN, not absent', async () => {
  // Removed? Never added? Added under another id? All different, none of them
  // "nothing downloaded yet".
  const elsewhere = (async () =>
    ({ ok: true, status: 200, text: async () => JSON.stringify([{ title: 'Other', tvdbId: 999 }]) }) as Response) as typeof fetch;
  const { out, sent } = await run(GUEST, elsewhere);
  assert.equal(out[0]?.action, 'deferred');
  assert.equal(sent.length, 0);
});

// ── one watch per title ──────────────────────────────────────────────────────

test('a second add of the same title does not create a second watch', async () => {
  const s = store();
  schedule(s, GUEST);
  assert.ok(s.pendingForSubject(GUEST, 'series', 73244), 'the first watch is found');
  assert.equal(s.pendingForSubject(GUEST, 'series', 99999), undefined, 'a different title is not');
  assert.equal(s.pendingForSubject(OWNER, 'series', 73244), undefined, 'nor a different person');
});

test('🔴 when NOTHING at all downloads, the user is still told — and told it will not self-resolve', async () => {
  const s = store();
  schedule(s, GUEST);
  const sent: { to: string; text: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = library({ 1: [0, 52], 2: [0, 52], 3: [0, 52] }) as typeof fetch;
  try {
    let last;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      for (const f of s.all()) if (f.status === 'pending') f.dueAt = new Date(Date.now() - 1000).toISOString();
      const r = await runDueFollowups(s, {
        config: testConfig({ ownerHandle: OWNER }),
        send: async (to, text) => {
          sent.push({ to, text });
        },
      });
      if (r.length) last = r;
    }
    assert.ok(sent.length >= 1, 'silence is the defect; it must speak');
    assert.match(sent[0]!.text, /nothing has downloaded/i);
    assert.match(sent[0]!.text, /will not arrive on its own/i);
    assert.doesNotMatch(sent[0]!.text, /available on Plex/i);
    assert.equal(last?.[0]?.action, 'abandoned');
  } finally {
    globalThis.fetch = orig;
  }
});
