import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import type { FetchImpl } from '../src/media/prowlarr.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
import { ALL_TOOLS, assertChoiceProducersExist, buildTools, registerable } from '../src/tools/index.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-release-')), 'choices.jsonl');

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const release = (o: Partial<Record<string, unknown>> = {}) => ({
  title: 'Project Hail Mary',
  infoHash: HASH_A,
  seeders: 20,
  size: 500 * 1024 ** 2,
  indexer: 'SomeIndexer',
  ...o,
});

const run = (f: FetchImpl, args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
  makeSearchAudiobook(f).run(args, ctx(over));

// ── 🔴 THE REGRESSION: the producer that did not exist ──────────────────────

test('🔴 READY PLAYER ONE: an audiobook search stores a pick add_audiobook can resolve', async () => {
  // Jeff, live: "Can you get the ready player one audiobook?" -> "I don't have
  // an audiobook search tool." add_audiobook was registered and uncallable.
  //
  // ⚠️ The seam this test guards is the STORE, not the prose: the producer
  // writes a list the consumer can resolve. It has survived the list being
  // withheld and then presented again, which is what makes it the right seam.
  const path = tempFile();
  const store = new ChoiceStore(path);
  const r = await run(
    async () => json([release({ title: 'Ready Player One', infoHash: HASH_A })]),
    { query: 'Ready Player One' },
    { choices: store },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /Ready Player One/);
  assert.match(r.content, /Call add_audiobook ONLY once they have answered/);
  assert.match(r.content, /Nothing is downloading yet/);

  // 🔴 The point of the whole exercise: the consumer can now resolve the pick.
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.equal(picked.ok, true);
  assert.equal(picked.ok && picked.option.value['infoHash'], HASH_A);
});

test('🔴 the stored option is EXACTLY the shape add_audiobook already reads', async () => {
  // The consumer ships and its contract is what the model has been told, so the
  // producer matches it rather than the other way round.
  const path = tempFile();
  await run(
    async () => json([release({ infoHash: HASH_A, guid: `magnet:?xt=urn:btih:${HASH_A}&tr=x` })]),
    { query: 'x' },
    { choices: new ChoiceStore(path) },
  );
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.ok(picked.ok);
  assert.deepEqual(picked.option.value, {
    // `source` was added when IRC became a second source. It is the discriminant
    // `send_ebook` switches on, so the consumer never has to guess which fetcher
    // a pick belongs to. `protocol` is the same kind of discriminant for Usenet;
    // add_audiobook does not read it and still grabs this hash.
    source: 'prowlarr',
    protocol: 'torrent',
    infoHash: HASH_A,
    title: 'Project Hail Mary',
    magnetUri: `magnet:?xt=urn:btih:${HASH_A}&tr=x`,
  });
});

test('the indexer\'s OWN magnet is preferred, and absent when there is none', async () => {
  const path = tempFile();
  await run(async () => json([release({ guid: 'https://indexer/download/1' })]), { query: 'x' }, {
    choices: new ChoiceStore(path),
  });
  const picked = new ChoiceStore(path).resolve('+18015550123', 1);
  assert.ok(picked.ok);
  assert.equal('magnetUri' in picked.option.value, false, 'a non-magnet guid is not stored as one');
});

test('search_ebook is the same producer pointed at the ebook category and send_ebook', async () => {
  let url = '';
  const r = await makeSearchEbook(async (u) => {
    url = String(u);
    return json([release()]);
  }).run({ query: 'Project Hail Mary' }, ctx());
  assert.equal(r.ok, true);
  assert.match(url, /categories=7020/, 'ebooks are Prowlarr category 7020');
  assert.match(r.content, /Call send_ebook ONLY once they have answered/);
});

test('search_audiobook uses the audiobook category', async () => {
  let url = '';
  await run(async (u) => {
    url = String(u);
    return json([release()]);
  }, { query: 'x' });
  assert.match(url, /categories=3030/, 'audiobooks are Prowlarr category 3030');
});

// ── 🔴 UNKNOWN IS NEVER "NO AUDIOBOOKS FOUND" ───────────────────────────────

test('🔴 an unreachable Prowlarr is UNKNOWN, not "nothing found"', async () => {
  const r = await run(() => {
    throw new Error('ECONNREFUSED');
  }, { query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
  assert.match(r.content, /NOT a finding that nothing exists/);
});

test('🔴 an http error from Prowlarr is UNKNOWN, not "none"', async () => {
  const r = await run(async () => json({}, 500), { query: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /UNKNOWN/);
});

test('🔴 an unconfigured Prowlarr is UNKNOWN and says it is not an absence', async () => {
  let called = false;
  const r = await run(
    async () => {
      called = true;
      return json([]);
    },
    { query: 'x' },
    { config: testConfig({ readOnly: false, prowlarr: { baseUrl: 'http://p.invalid', apiKey: '' } }) },
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /not "no audiobooks exist"/);
  assert.equal(called, false);
});

test('CONTROL: a real empty result IS a finding — NOT FOUND, not UNKNOWN', async () => {
  /**
   * 🪦 THIS USED TO ASSERT `/^NONE/`. The premise — an empty answer from a
   * reachable indexer is a FINDING and must not be dressed up as a failure to
   * look — is unchanged and is what the two assertions below still pin. Only
   * the head word moved: `NONE` was read back to Jeff as *"Prowlarr has no
   * audiobook release for it"*, and the head is the part of this string a model
   * paraphrases. `NOT FOUND` says the same thing about OUR search without
   * saying it about the world.
   */
  const r = await run(async () => json([]), { query: 'x' });
  assert.equal(r.ok, true);
  assert.match(r.content, /^NOT FOUND/);
  assert.doesNotMatch(r.content, /UNKNOWN/);
  // 🔴 And it must not have become the claim it replaced.
  assert.match(r.content, /NOT a finding that the audiobook does not exist/);
});

test('found-but-unfetchable is reported distinctly from found-nothing', async () => {
  // A release with no infoHash cannot be grabbed at all; saying "nothing found"
  // would be a different, wrong answer.
  const r = await run(async () => json([release({ infoHash: 'not-a-hash' })]), { query: 'x' });
  assert.match(r.content, /none carried an infoHash/);
});

test('a partly-unfetchable result set says how many were dropped', async () => {
  // ⚠️ WORDING ONLY. The behaviour here is unchanged — this row has neither an
  // infoHash nor a downloadUrl, so it is still dropped. The NOTE now names both
  // conditions, because "no infoHash" stopped being the same thing as
  // "unfetchable" once a download link became resolvable. See prowlarr.ts.
  const r = await run(
    async () => json([release({ infoHash: HASH_A }), release({ infoHash: 'nope' })]),
    { query: 'x' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1 more had no infoHash or download link and cannot be fetched/);
});

test('🔴 a row with a download link is KEPT and offered, not counted as dropped', async () => {
  /**
   * ⚠️ ASSERTS THE BEHAVIOUR, NOT THE ABSENCE OF A STRING. The first version of
   * this test only said the "dropped" note was absent — which is ALSO true under
   * the old code, where the row is discarded and the note is worded differently.
   * It was green on the code it exists to reject.
   */
  const r = await run(
    async () =>
      json([
        release({ title: 'Copy A', infoHash: HASH_A }),
        release({ title: 'Copy B', infoHash: 'nope', downloadUrl: 'http://prowlarr/proxy/1' }),
      ]),
    { query: 'x' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /Copy B/, 'the resolvable row must reach the person');
  assert.doesNotMatch(r.content, /had no infoHash or download link/);
});

// ── 🔴 A FILTER THAT ATE EVERYTHING IS NOT AN ABSENCE ───────────────────────

test('🔴 GraphicAudio: when the filter removes them ALL, it says so rather than "none found"', async () => {
  const r = await run(
    async () => json([release({ title: 'Project Hail Mary [GraphicAudio]' }), release({ title: 'PHM Graphic Audio', infoHash: HASH_B })]),
    { query: 'Project Hail Mary' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /FILTERED OUT/);
  assert.match(r.content, /found 2 audiobook release\(s\)/);
  assert.match(r.content, /EVERY one is a GraphicAudio/);
  assert.doesNotMatch(r.content, /^NONE/);
});

test('asking FOR GraphicAudio when there are none says that, not "no audiobooks"', async () => {
  const r = await run(async () => json([release()]), { query: 'x', graphic_audio: true });
  assert.match(r.content, /FILTERED OUT/);
  assert.match(r.content, /NONE of them are GraphicAudio/);
});

test('GraphicAudio releases are excluded by default and the exclusion is COUNTED', async () => {
  const r = await run(
    async () =>
      json([release({ infoHash: HASH_A }), release({ title: 'PHM GRAPHIC-AUDIO', infoHash: HASH_B })]),
    { query: 'x' },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /1 GraphicAudio release\(s\) left out/);
  assert.doesNotMatch(r.content, /GRAPHIC-AUDIO/);
});

test('graphic_audio: true keeps ONLY the dramatisations', async () => {
  const r = await run(
    async () =>
      json([release({ infoHash: HASH_A }), release({ title: 'PHM GraphicAudio', infoHash: HASH_B })]),
    { query: 'x', graphic_audio: true },
  );
  assert.match(r.content, /PHM GraphicAudio/);
  assert.doesNotMatch(r.content, /Project Hail Mary —/);
});

// ── list mechanics ──────────────────────────────────────────────────────────

test('a dead release is EXCLUDED and counted — it is not a lesser option, it is no option', async () => {
  // It used to sort to the bottom, which was fine while a person was choosing
  // from a list. A comparator choosing silently can take the bottom of a list,
  // so it is filtered instead.
  const r = await run(
    async () =>
      json([
        release({ title: 'Dead', infoHash: HASH_A, seeders: 0 }),
        release({ title: 'Alive', infoHash: HASH_B, seeders: 9 }),
      ]),
    { query: 'x' },
  );
  assert.match(r.content, /Alive/);
  assert.doesNotMatch(r.content, /Dead —/, 'the zero-seeder release is not chosen and not offered');
  assert.match(r.content, /1 with no seeders left out/, 'and it is counted, never dropped in silence');
});

test('the list is capped at five, in ranked order, and the count is not inflated', async () => {
  // A book search asks now, so the releases ARE printed — but a numbered list is
  // something a person has to read, and nine rows of near-identical filenames is
  // not a question anybody can answer. Five, best first.
  const many = Array.from({ length: 9 }, (_, i) =>
    release({ title: `Release ${i}`, infoHash: `${i}`.repeat(40).slice(0, 40), seeders: 20 - i }),
  );
  const r = await run(async () => json(many), { query: 'x' });
  assert.match(r.content, /^\s*1\. Release 0/m, 'the top of the ranking is option 1');
  assert.match(r.content, /^\s*5\. Release 4/m);
  assert.doesNotMatch(r.content, /^\s*6\./m, 'nothing past five');
  assert.match(r.content, /FOUND 5 for "x"/, 'and it says five, not nine — it must not overstate the list');
});

test('🔴 with no choice store it refuses — a list nothing can resolve is not an offer', async () => {
  // Unlike catalogue_search there is no alternative route: add_audiobook takes
  // ONLY a pick, so an unstorable list offers a flow that cannot complete.
  const r = await run(async () => json([release()]), { query: 'x' }, { choices: undefined });
  assert.equal(r.ok, false);
  assert.match(r.content, /nowhere to record a numbered list/);
});

test('an empty query asks rather than searching for nothing', async () => {
  let called = false;
  const r = await run(
    async () => {
      called = true;
      return json([]);
    },
    { query: '   ' },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

// ── 🔴 THE INVARIANT: a consumer without a producer must not boot ───────────

test('🔴 an "audiobook-release" consumer with NO registered producer REFUSES to register', async () => {
  /**
   * The exact state add_audiobook and send_ebook shipped in: registered,
   * booting, in the live tool line, uncallable. Every check we had passed,
   * because they all quantify over declarations and none knew that one tool's
   * required argument is another tool's output.
   */
  const orphan = ALL_TOOLS.filter((t) => t.name === 'add_audiobook');
  assert.equal(orphan.length, 1, 'CONTROL: the consumer exists to be orphaned');
  assert.throws(
    () => registerable(orphan, testConfig({ readOnly: false })),
    /resolves a "audiobook-release" choice, but NO registered tool presents one/,
  );
});

test('CONTROL: the same consumer registers fine once its producer is present', async () => {
  const pair = ALL_TOOLS.filter((t) => t.name === 'add_audiobook' || t.name === 'search_audiobook');
  assert.equal(pair.length, 2);
  assert.doesNotThrow(() => registerable(pair, testConfig({ readOnly: false })));
});

test('🔴 a tool REQUIRING a choice without declaring the kind is REFUSED, not defaulted', async () => {
  // Detected from the SCHEMA, so an author cannot forget it — the same
  // discipline as `writes`, and for the same reason.
  const undeclared: Tool = {
    name: 'mystery_consumer',
    description: 'x'.repeat(30),
    minRole: 'guest',
    writes: false,
    parameters: { type: 'object', properties: { choice: { type: 'number' } }, required: ['choice'] },
    run: async () => ({ ok: true, content: '' }),
  };
  assert.throws(() => registerable([undeclared], testConfig()), /does not declare consumesChoiceKind/);
});

test("resolve_choice's '*' is exempt, because it genuinely resolves any kind", async () => {
  const generic = ALL_TOOLS.filter((t) => t.name === 'resolve_choice');
  assert.equal(generic[0]?.consumesChoiceKind, '*');
  assert.doesNotThrow(() => registerable(generic, testConfig()));
});

test('🔴 the SHIPPED registry satisfies it, in both read-only and write modes', async () => {
  // The read-only build is checked AS the read-only build: a producer that was a
  // write tool would vanish with writes off, and that would be a real hole.
  assert.doesNotThrow(() => buildTools(testConfig({ readOnly: true })));
  assert.doesNotThrow(() => buildTools(testConfig({ readOnly: false })));
  assert.doesNotThrow(() => assertChoiceProducersExist(ALL_TOOLS));
});

test('every choice-consuming tool in the shipped registry has a live producer', async () => {
  const built = buildTools(testConfig({ readOnly: false }));
  const produced = new Set(built.flatMap((t) => t.presentsChoiceKinds ?? []));
  const consumed = built.map((t) => t.consumesChoiceKind).filter((k): k is string => !!k && k !== '*');
  assert.ok(consumed.length >= 2, `CONTROL: found only ${consumed.length} consumers`);
  for (const k of consumed) assert.ok(produced.has(k), `nothing produces "${k}"`);
});

test('add_audiobook is reachable end to end: search stores, consumer resolves', async () => {
  // Not a mock of the pick — the real consumer, reading the real store.
  const path = tempFile();
  await run(async () => json([release({ infoHash: HASH_A })]), { query: 'x' }, { choices: new ChoiceStore(path) });
  const out = await addAudiobook.run(
    { choice: 1 },
    ctx({ choices: new ChoiceStore(path), config: testConfig({ readOnly: true }) }),
  );
  // Writes are off, so it refuses — but it refuses for THAT reason, having
  // resolved the pick, rather than for "no list".
  assert.match(out.content, /Writes are disabled/);
  assert.doesNotMatch(out.content, /NONE —|no list/i);
});

// ── the SECOND axis: a tool that NAMES a producer in its description ────────

test('🔴 removing catalogue_search fails add_movie AND add_series', async () => {
  /**
   * The mutation team-lead specified. This axis catches a different set from the
   * structural one and neither subsumes the other: `add_movie` takes a
   * `tmdb_id`, not a `choice`, so the choice-kind check cannot see its
   * dependency — it is stated only in prose ("use the tmdbId from
   * catalogue_search") that nothing read until now.
   */
  for (const consumer of ['add_movie', 'add_series']) {
    const without = ALL_TOOLS.filter((t) => t.name === consumer);
    assert.throws(
      () => registerable(without, testConfig({ readOnly: false })),
      new RegExp(`Tool "${consumer}" tells the model to use "catalogue_search", which is NOT registered`),
      `${consumer} must not register without its named producer`,
    );
  }
});

test('CONTROL: both register fine WITH catalogue_search present', async () => {
  const withIt = ALL_TOOLS.filter((t) =>
    ['add_movie', 'add_series', 'catalogue_search'].includes(t.name),
  );
  assert.equal(withIt.length, 3);
  assert.doesNotThrow(() => registerable(withIt, testConfig({ readOnly: false })));
});

test('🔴 the two axes catch DIFFERENT tools — neither check is redundant', async () => {
  /**
   * The name scan and the structural check see different dependencies, and this
   * pins that they are not the same check twice.
   *
   * ⚠️ TOMBSTONE — DO NOT RESTORE THE OLD FORM OF THIS TEST. It used to prove
   * the structural half by asserting `add_audiobook.description` does NOT say
   * "search_audiobook". That was true by accident of wording, and the wording
   * changed the day the release pick became automatic and every consumer started
   * naming the search that chose for it. Asserting a tool does not mention
   * another tool is a constraint on prose, not on the check, so it is replaced
   * with a synthetic pair that cannot drift.
   */
  const structuralOnly: Tool = {
    name: 'fake_consumer',
    description: 'Consumes a pick and names no producer anywhere in this sentence.',
    minRole: 'guest',
    writes: false,
    consumesChoiceKind: 'no-such-kind',
    parameters: { type: 'object', properties: { choice: { type: 'number' } }, required: ['choice'] },
    run: async () => ({ ok: true, content: '' }),
  };
  assert.throws(
    () => assertChoiceProducersExist([structuralOnly]),
    /NO registered tool presents one/,
    'a dependency expressed only in the SCHEMA — invisible to a name scan',
  );

  const movie = ALL_TOOLS.find((t) => t.name === 'add_movie')!;
  assert.match(movie.description, /catalogue_search/, 'names its producer — only the name check sees it');
  assert.equal(movie.consumesChoiceKind, undefined, 'and it consumes no choice at all');
  assert.doesNotThrow(
    () => assertChoiceProducersExist([movie]),
    'so the structural check is blind to add_movie, which is the other half of the point',
  );
});

test('🔴 the EBOOK PAIR is atomic: no SMTP credential means neither half registers', async () => {
  // search_ebook's description names send_ebook. With no SMTP credential
  // send_ebook does not exist, so search_ebook shipped a flow whose second step
  // was absent — books found, none sendable. Caught by the name check on its
  // first run.
  const withSmtp = buildTools(testConfig({ readOnly: false }), undefined, {
    ebook: { send: async () => ({ messageId: 'x' }) },
  }).map((t) => t.name);
  assert.ok(withSmtp.includes('send_ebook') && withSmtp.includes('search_ebook'), 'both, with a credential');

  const noSmtp = buildTools(
    testConfig({ readOnly: false, kindle: { smtpHost: 'x', smtpPort: 1, fromEmail: 'a@b', smtpPassword: '' } }),
    undefined,
    { ebook: { send: async () => ({ messageId: 'x' }) } },
  ).map((t) => t.name);
  assert.equal(noSmtp.includes('send_ebook'), false);
  assert.equal(noSmtp.includes('search_ebook'), false, 'and the producer goes with it');
});
