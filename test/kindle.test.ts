import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KindleRegistry, normaliseKindleAddress } from '../src/kindle.js';
import { testConfig } from './helpers.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jedd-kindle-')), 'kindle.jsonl');
}

const JEFF = '+18015550123';
const OTHER = '+13855550168';

// ── 🔴 the fabricated address ────────────────────────────────────────────────

test('🔴 THE ACTUAL INCIDENT: a fabricated address cannot be stored', async () => {
  // Verbatim from the corpus: Jeff typed readerthree@kindle.com at
  // 2026-08-23 16:49. The address persisted for a DIFFERENT user 1h43m later was
  // readerfour@kindle.com -- the same string with the middle removed. The
  // `_27e778` suffix is an exact match on a random token, so it reached the
  // model's context from somewhere; it was never typed by that user.
  const reg = new KindleRegistry(tempFile());
  const otherUserTurns = ['Can you get Way of Kings on my kindle?', 'Number 1 is great'];
  const r = reg.save(OTHER, 'readerfour@kindle.com', otherUserTurns);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('unreachable');
  assert.match(r.reason, /does not appear in anything this person typed/i);
  assert.equal(reg.get(OTHER), undefined, 'and nothing was stored');
});

test('🔴 a syntactically PERFECT address is still refused without provenance', async () => {
  // The point: no property of the STRING distinguishes a real address from a
  // plausible fabrication. A validator would have passed the one that shipped.
  const reg = new KindleRegistry(tempFile());
  const r = reg.save(OTHER, 'ReaderTwo@kindle.com', ['hi', 'can you get me a book']);
  assert.equal(r.ok, false);
});

test('CONTROL: an address the person DID type is stored', async () => {
  // Without this, "refused" would be consistent with the store never accepting
  // anything, which would be a passing test that proves nothing.
  const reg = new KindleRegistry(tempFile());
  const r = reg.save(OTHER, 'ReaderTwo@kindle.com', ['ReaderTwo@kindle.com']);
  assert.equal(r.ok, true);
  assert.equal(reg.get(OTHER)?.address, 'ReaderTwo@kindle.com');
});

test("🔴 one person's address is not provenance for another's", async () => {
  // This is the cross-session shape of the real incident.
  const reg = new KindleRegistry(tempFile());
  reg.save(JEFF, 'readerthree@kindle.com', ['readerthree@kindle.com']);
  const r = reg.save(OTHER, 'readerthree@kindle.com', ['get me the anxious generation']);
  assert.equal(r.ok, false, "another person's turns are not this person's provenance");
});

test('🔴 the ASSISTANT saying an address is not provenance', async () => {
  // userTurns must contain ONLY what the user typed. V1's grounding corpus bug
  // was exactly this: a loose role filter let assistant text count as evidence.
  const reg = new KindleRegistry(tempFile());
  const onlyUserTurns = ['what do you need?'];
  const r = reg.save(OTHER, 'readerfive@kindle.com', onlyUserTurns);
  assert.equal(r.ok, false);
});

// ── the address itself ───────────────────────────────────────────────────────

test('🔴 the local part is stored VERBATIM; only the domain is lowercased', async () => {
  // V1 lowercased the whole address in front of the user, corrupting it and
  // forcing a re-onboarding.
  assert.equal(normaliseKindleAddress('ReaderTwo@KINDLE.COM'), 'ReaderTwo@kindle.com');
});

test('an Amazon LOGIN address is refused — it is not a delivery address', async () => {
  // The common user mistake. Sending there silently does nothing.
  assert.equal(normaliseKindleAddress('personfour@example.com'), null);
  assert.equal(normaliseKindleAddress('someone@amazon.com'), null);
  assert.equal(normaliseKindleAddress('not-an-address'), null);
});

test('matching is case-insensitive even though storage is not', async () => {
  const reg = new KindleRegistry(tempFile());
  const r = reg.save(OTHER, 'ReaderTwo@kindle.com', ['my kindle is readertwo@KINDLE.COM']);
  assert.equal(r.ok, true, 'the user typing it in a different case is still the same address');
});

test('an address survives a restart', async () => {
  const path = tempFile();
  new KindleRegistry(path).save(OTHER, 'readerone@kindle.com', ['readerone@kindle.com']);
  assert.equal(new KindleRegistry(path).get(OTHER)?.address, 'readerone@kindle.com');
});

test('the source text is kept, so provenance is auditable after the fact', async () => {
  const reg = new KindleRegistry(tempFile());
  reg.save(OTHER, 'readerone@kindle.com', ['here you go: readerone@kindle.com thanks']);
  assert.match(reg.get(OTHER)!.sourceText, /here you go/);
});

// ── through the TOOL, which is where the model actually reaches it ───────────

test('🔴 the TOOL refuses a fabricated address even though it is well-formed', async () => {
  const { saveKindleEmail } = await import('../src/tools/kindle.js');
  const { testConfig } = await import('./helpers.js');
  const reg = new KindleRegistry(tempFile());
  const r = await saveKindleEmail.run(
    { address: 'readerfour@kindle.com' },
    {
      role: 'guest',
      senderHandle: JEFF,
      config: testConfig({ readOnly: false }),
      kindle: reg,
      userTurns: ['Can you get Way of Kings on my kindle?'],
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /does not appear in anything this person typed/i);
  assert.equal(reg.get(JEFF), undefined);
});

test('CONTROL: the tool stores an address the person did type', async () => {
  const { saveKindleEmail } = await import('../src/tools/kindle.js');
  const { testConfig } = await import('./helpers.js');
  const reg = new KindleRegistry(tempFile());
  const r = await saveKindleEmail.run(
    { address: 'ReaderTwo@kindle.com' },
    {
      role: 'guest',
      senderHandle: JEFF,
      config: testConfig({ readOnly: false }),
      kindle: reg,
      userTurns: ['my kindle is ReaderTwo@kindle.com'],
    },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /approved-senders/i, 'and it owes them the Amazon reminder');
});

test('🔴 EVERY tool that accepts a delivery address REFUSES one nobody typed', async () => {
  /**
   * This used to be a NAME check with a hardcoded exception:
   *
   *   `!/mail|address|recipient|send_to/i.test(key) || t.name === 'save_kindle_email'`
   *
   * — i.e. "no tool may take an address, except the one that does". That is an
   * allowlist, and an allowlist grows: `invite_to_jellyfin` takes a `recipient`
   * for the same reason `save_kindle_email` takes an `address` — the person is
   * telling us where to send something — and adding a second name to the
   * exception would have turned the guard into a list of tools somebody
   * remembered to think about.
   *
   * 🔴 The rule the two tools actually share is PROVENANCE, and provenance is a
   * BEHAVIOUR, so it is checked by CALLING them: given a well-formed address
   * that does not appear in this person's own messages, the tool must refuse.
   * That is strictly stronger than the name check it replaces — it now also
   * holds `save_kindle_email` to the rule instead of exempting it by name.
   */
  const { ALL_TOOLS } = await import('../src/tools/index.js');
  const ADDRESSISH = /mail|address|recipient|send_to/i;
  let exercised = 0;

  for (const t of ALL_TOOLS) {
    const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of Object.keys(props)) {
      if (!ADDRESSISH.test(key)) continue;
      exercised += 1;
      const r = await t.run(
        // Well-formed, plausible, and never typed by this person. A validator
        // passes it; only provenance rejects it.
        { [key]: key === 'recipient' ? '+18015559999' : 'ReaderTwo@kindle.com' },
        {
          role: 'owner',
          senderHandle: JEFF,
          // 🔴 Writes ENABLED. With writes off every tool here refuses for the
          // wrong reason, and a refusal that is not about provenance would let
          // this test pass on a tool that has no provenance check at all.
          config: testConfig({ readOnly: false }),
          kindle: new KindleRegistry(tempFile()),
          userTurns: ['hey', 'can you get me a book'],
        },
      );
      assert.equal(r.ok, false, `${t.name} accepted a "${key}" nobody typed`);
      assert.match(
        r.content,
        /does not appear in anything this person typed/i,
        `${t.name} refused "${key}", but not because of provenance`,
      );
    }
  }

  // 🔴 FAILING CONTROL. A loop over zero matches passes silently, and this
  // invariant is only worth anything if it ran.
  assert.ok(exercised >= 2, `only ${exercised} address-shaped parameter(s) were exercised`);
});
