import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { resetTransportBreaker, type FetchImpl } from '../src/media/arr.js';
import type { ExecImpl } from '../src/hp.js';
import type { IrcEbooks } from '../src/media/irc-ebooks.js';
import { byScore, swarmHealth, swarmRank, HEALTHY_SWARM_SEEDERS } from '../src/media/pick-release.js';
import { rankAudiobooks, rankReleases, type Release } from '../src/media/prowlarr.js';
import { addAudiobook } from '../src/tools/add-audiobook.js';
import { makeCatalogueSearch } from '../src/tools/catalogue.js';
import { resolveChoice } from '../src/tools/choice.js';
import { makeGrabRelease, makeSearchEpisode } from '../src/tools/fill-gaps.js';
import { makeSearchAudiobook, makeSearchEbook } from '../src/tools/search-release.js';
import { assertChoiceProducersExist } from '../src/tools/index.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 THE TRANSPORT BREAKER IS PROCESS-GLOBAL. `makeCatalogueSearch` reaches
 * the configured `*.invalid` URLs when its stub throws, and a sibling file's
 * failure against the same URL would otherwise leak into the assertions here.
 */
beforeEach(() => {
  resetTransportBreaker();
});

/**
 * NOBODY IS ASKED WHICH TORRENT ANY MORE — AND THE ONE WE TAKE IS CHOSEN ON THE
 * SWARM, NOT ON THE NAME.
 *
 * Jeff, verbatim: *"When downloading media, don't give users a choice of which
 * torrent to choose, just choose the best one."*
 *
 * ── 🔴 THE FIXTURE IN THIS FILE IS A REAL INCIDENT ──────────────────────────
 *
 * 2026-08-26 on hp: Sonarr had grabbed Fringe S02 from a pool of 2009 720p-HDTV
 * releases the quality profile approved. `time_active` 50–60 h, `num_complete`
 * **0**, **zero bytes moved, ever**. Every one of them read as respectable by
 * name. Blocklisting them and taking a 1080p AMZN WEB-DL — which the profile
 * REFUSES — finished in minutes.
 *
 * So `THE_FRINGE_SHAPE` below is not an invented edge case. It is the shape that
 * cost sixty hours, and the ordering that produced it is the one this file
 * exists to keep out.
 *
 * ── ⚠️ AND WHAT THIS DELIBERATELY DOES NOT TOUCH ────────────────────────────
 *
 * Which WORK someone meant is still their call, and the last test here pins it.
 * Robin asked for *"Don't Say Good Luck"*, Jedd asked *"the 2026 film or the
 * 2003 show?"*, and that question was CORRECT — they are different works and
 * guessing downloads the wrong one. Release choice is not title choice.
 *
 * ── 🔴 WHICH IS WHY THE BOOK TESTS BELOW NOW ASSERT ORDER, NOT ABSENCE ──────
 *
 * The rule above is a rule about copies of ONE thing. `search_episode` pins the
 * episode against Sonarr before it ranks anything, so it holds there and every
 * TV assertion in this file is unchanged. `search_ebook`/`search_audiobook` take
 * FREE TEXT and their candidates are different WORKS, so auto-picking there was
 * answering the wrong question — see `book-work-identity.test.ts`. The ranking
 * did not change and neither did what it ranks first; only whether the losers
 * are printed. Do not "restore" the `doesNotMatch` assertions.
 */

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jedd-autopick-')), 'choices.jsonl');

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  role: 'guest',
  senderHandle: '+18015550123',
  config: testConfig({ readOnly: false }),
  choices: new ChoiceStore(tempFile()),
  ...over,
});

const json = async (body: unknown, status = 200): Promise<Response> =>
  ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

// ── the Sonarr side ─────────────────────────────────────────────────────────

const SERIES = { id: 80, tvdbId: 79169, title: 'Fringe', year: 2008, monitored: true, seasons: [] };
const EPISODE = {
  id: 4242,
  seasonNumber: 2,
  episodeNumber: 1,
  title: 'A New Day in the Old Town',
  monitored: true,
  hasFile: false,
  airDateUtc: '2009-09-17T01:00:00Z',
};

interface RelSpec {
  guid: string;
  title: string;
  quality: string;
  resolution: number;
  seeders: number;
  approved: boolean;
}

const arrRelease = (r: RelSpec) => ({
  guid: r.guid,
  indexerId: 4,
  title: r.title,
  indexer: 'SomeIndexer',
  quality: { quality: { name: r.quality, resolution: r.resolution } },
  seeders: r.seeders,
  size: 2 * 1024 ** 3,
  approved: r.approved,
  rejections: r.approved ? [] : [`${r.quality} is not wanted in profile`],
  customFormatScore: 0,
  languages: [{ name: 'English' }],
});

/**
 * 🔴 THE FRINGE SHAPE.
 *
 * `DEAD_720` is what the profile likes: approved, and the release Sonarr
 * actually took. Its swarm is two people. `LIVE_1080` is what finished in
 * minutes: refused by the profile, higher resolution, and a swarm that exists.
 *
 * ⚠️ The dead one is on TWO seeders and not zero ON PURPOSE. Zero is already
 * filtered out before ranking ever runs, so a zero-seeder fixture would pass
 * with the ranking removed entirely and prove nothing about the ORDER. Two puts
 * it in the `thin` band — alive, rankable, and still the wrong answer.
 */
const DEAD_720: RelSpec = {
  guid: 'guid-dead-720',
  title: 'Fringe S02E01 720p HDTV x264',
  quality: 'HDTV-720p',
  resolution: 720,
  seeders: 2,
  approved: true,
};
const LIVE_1080: RelSpec = {
  guid: 'guid-live-1080',
  title: 'Fringe S02E01 1080p AMZN WEB-DL DDP5 1 H 264',
  quality: 'WEBDL-1080p',
  resolution: 1080,
  seeders: 400,
  approved: false,
};

function sonarr(releases: RelSpec[]): { fetchImpl: FetchImpl; posts: Record<string, unknown>[] } {
  const posts: Record<string, unknown>[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    if ((init?.method ?? 'GET') !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(body);
      return json(body, 201);
    }
    if (u.includes('/episode?')) return json([EPISODE]);
    if (u.includes('/release?')) return json(releases.map(arrRelease));
    if (u.includes('/queue')) return json({ records: [], totalRecords: 0 });
    if (u.endsWith('/series')) return json([SERIES]);
    return json([]);
  };
  return { fetchImpl, posts };
}

const searchFringe = (releases: RelSpec[], over: Partial<ToolContext> = {}) =>
  makeSearchEpisode(sonarr(releases).fetchImpl).run(
    { title: 'Fringe', season: 2, episode: 1 },
    ctx(over),
  );

// ── 🔴 THE RANKING ──────────────────────────────────────────────────────────

test('🔴 FRINGE: the LIVE release is chosen over the better-labelled DEAD one', async () => {
  const r = await searchFringe([DEAD_720, LIVE_1080]);
  assert.equal(r.ok, true);
  assert.match(r.content, /1080p AMZN WEB-DL/, 'the one with a swarm is the one we take');
  assert.doesNotMatch(
    r.content,
    /720p HDTV/,
    'the approved-but-nearly-dead release is not even mentioned — it is not a choice on offer',
  );
});

test('🔴 MUTATION: rank on the LABEL instead of the swarm and the wrong release wins', async () => {
  /**
   * This is the control that makes the test above non-vacuous, and it is the
   * exact comparator `search_episode` shipped with until this change:
   *
   *     approved DESC, resolution DESC, seeders DESC
   *
   * Run over the same fixture it returns the release that moved zero bytes for
   * sixty hours. If someone deletes `swarmRank` from the score vector, the
   * assertion above starts failing and this one keeps passing — which is the
   * whole point of writing both.
   */
  const labelFirst = [DEAD_720, LIVE_1080].sort(
    byScore((r) => [Number(r.approved), r.resolution, r.seeders]),
  );
  assert.equal(labelFirst[0]!.guid, DEAD_720.guid, 'label-first picks the dead one — that is the bug');

  const swarmFirst = [DEAD_720, LIVE_1080].sort(
    byScore((r) => [swarmRank(r.seeders), Number(r.approved), r.resolution, r.seeders]),
  );
  assert.equal(swarmFirst[0]!.guid, LIVE_1080.guid, 'swarm-first picks the one that finishes');

  assert.notEqual(
    labelFirst[0]!.guid,
    swarmFirst[0]!.guid,
    'the two orderings must DISAGREE on this fixture, or the shipped test proves nothing',
  );
});

test('quality still decides INSIDE a band — the swarm rule does not throw the profile away', async () => {
  // Both healthy, so `approved` and resolution get to matter again. A rule that
  // ranked on raw seeders would hand every decision to popularity instead.
  const approved720: RelSpec = { ...DEAD_720, seeders: 60 };
  const r = await searchFringe([approved720, LIVE_1080]);
  assert.match(r.content, /720p HDTV/, 'with a live swarm of its own, the profile-approved one wins');
});

// ── 🔴 NO NUMBERED PICK EVER REACHES THE MODEL ──────────────────────────────

test('🔴 the tool result contains NO numbered list — the model cannot offer what it never got', async () => {
  const r = await searchFringe([DEAD_720, LIVE_1080]);
  assert.doesNotMatch(r.content, /^\s*\d+\.\s/m, 'a numbered option line is exactly what was removed');
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /do NOT ask which torrent/i);
  assert.match(r.content, /Nothing is downloading yet/);
});

test('the alternatives are PERSISTED even though they are never printed', async () => {
  // Withheld from the prose, not discarded: "actually, the other one" still has
  // something to resolve against.
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });
  const store = new ChoiceStore(path);
  assert.equal(store.resolve('+18015550123', 1).ok, true);
  const second = store.resolve('+18015550123', 2);
  assert.ok(second.ok);
  assert.equal(second.option.value['guid'], DEAD_720.guid, 'option 2 is the one we did not take');
});

// ── 🔴 THE GRAB TAKES THE CHOSEN ONE WITH NO ARGUMENT ───────────────────────

test('🔴 grab_release called with NO arguments grabs the release that was chosen', async () => {
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });

  const { fetchImpl, posts } = sonarr([DEAD_720, LIVE_1080]);
  const r = await makeGrabRelease(fetchImpl).run({}, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(r.ok, true, r.content);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!['guid'], LIVE_1080.guid, 'the one with the swarm, without anybody being asked');
});

test('an explicit number is still honoured — "no, the other one" remains serviceable', async () => {
  const path = tempFile();
  await searchFringe([DEAD_720, LIVE_1080], { choices: new ChoiceStore(path) });

  const { fetchImpl, posts } = sonarr([DEAD_720, LIVE_1080]);
  await makeGrabRelease(fetchImpl).run({ choice: 2 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(posts[0]!['guid'], DEAD_720.guid, 'a person who names a number overrides the ranking');
});

// ── 🔴 THE POLICY THAT USED TO LIVE IN A DESCRIPTION ────────────────────────

test('🔴 4K is excluded IN CODE now that a comparator is doing the choosing', async () => {
  /**
   * *"Do NOT offer or grab 4K / 2160p releases"* was an instruction in
   * `search_episode`'s description, and it worked because a model read the list.
   * A comparator does not read descriptions: a 2160p remux with a big swarm wins
   * every key. So it is a filter now, and this is what proves it.
   */
  const huge: RelSpec = {
    guid: 'guid-2160',
    title: 'Fringe S02E01 2160p UHD BluRay REMUX',
    quality: 'Bluray-2160p',
    resolution: 2160,
    seeders: 900,
    approved: false,
  };
  const r = await searchFringe([huge, LIVE_1080]);
  assert.match(r.content, /1080p AMZN WEB-DL/);
  assert.doesNotMatch(r.content, /2160p/, 'the biggest swarm in the list does not get to win');
  assert.match(r.content, /1 above 1080p/, 'and it is COUNTED, not dropped in silence');
});

// ── 🔴 AUDIOBOOKS AND EBOOKS TAKE THE SAME RULE ─────────────────────────────

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const prowlarrRelease = (o: Record<string, unknown>) => ({
  title: 'Book',
  infoHash: HASH_A,
  seeders: 20,
  size: 500 * 1024 ** 2,
  indexer: 'SomeIndexer',
  ...o,
});

/**
 * ⚠️ THE BOOK ASSERTIONS BELOW CHANGED SHAPE, AND THE RULE THEY PIN DID NOT.
 *
 * They used to read "the runner-up is not even mentioned", because the book
 * searches auto-picked and returned one release. Books ASK now — see
 * `book-work-identity.test.ts` for why — so the runner-up IS printed, and
 * absence is no longer available as evidence.
 *
 * So they assert the ORDER instead: the ranking still decides which release is
 * option 1, and option 1 is still what a person is looking at first. An
 * assertion that the losing release is missing would have had to be deleted; an
 * assertion that it ranks SECOND survives the presentation changing, which is
 * the more durable statement of the same rule.
 */
const optionLine = (content: string, n: number): string =>
  content.split('\n').find((l) => l.trim().startsWith(`${n}. `)) ?? `<no option ${n}>`;

test('🔴 search_audiobook ranks the healthy swarm to option 1 and offers the list', async () => {
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune (thin swarm)', infoHash: HASH_A, seeders: 2 }),
      prowlarrRelease({ title: 'Dune (healthy swarm)', infoHash: HASH_B, seeders: 300 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(optionLine(r.content, 1), /healthy swarm/, 'the swarm still decides the order');
  assert.match(optionLine(r.content, 2), /thin swarm/);
  assert.match(r.content, /ASK WHICH BOOK THEY MEANT/);
});

test('🔴 add_audiobook grabs the release the person NUMBERED', async () => {
  const path = tempFile();
  await makeSearchAudiobook(async () =>
    json([prowlarrRelease({ title: 'Dune', infoHash: HASH_B, seeders: 300 })]),
  ).run({ query: 'Dune' }, ctx({ choices: new ChoiceStore(path) }));

  const cmds: string[] = [];
  const replies = ['', 'Ok.\n200', ''];
  let i = 0;
  const exec: ExecImpl = (_f, args, _o, cb) => {
    cmds.push(args[args.length - 1]!);
    cb(null, replies[Math.min(i++, replies.length - 1)]!, '');
  };

  const r = await addAudiobook.run({ choice: 1 }, ctx({ choices: new ChoiceStore(path), exec }));
  assert.equal(r.ok, true, r.content);
  assert.ok(
    cmds.some((c) => c.includes(HASH_B)),
    `the chosen infoHash reached the download client: ${cmds.join(' | ')}`,
  );
});

test('🔴 a healthy ABRIDGED copy is ranked ABOVE an unabridged one nobody is seeding', async () => {
  // The band has to sit above the quality key or it is decorative. Unabridged is
  // the better book and a thin swarm is the one that does not arrive.
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune Unabridged', infoHash: HASH_A, seeders: 2 }),
      prowlarrRelease({ title: 'Dune abridged', infoHash: HASH_B, seeders: 300 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.match(optionLine(r.content, 1), /Dune abridged/);
  assert.match(optionLine(r.content, 2), /Unabridged/);
});

test('CONTROL: with the swarms level, unabridged wins — the quality key still works', async () => {
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune abridged', infoHash: HASH_B, seeders: 300 }),
      prowlarrRelease({ title: 'Dune Unabridged', infoHash: HASH_A, seeders: 300 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.match(optionLine(r.content, 1), /Dune Unabridged/);
});

// ── 🔴 THE EBOOK PATH, WHICH HAD A SECOND COMPARATOR HIDING UNDER THE FIRST ──

test('🔴 EBOOK: a 500-seeder .azw3 beats a 1-seeder .epub', async () => {
  /**
   * This shipped WRONG for a day and the review caught it. The ranker ran, and
   * then `interleave` re-sorted the whole merged list on `isEpub` with no swarm
   * term — and `interleave`'s output is what gets grabbed. So the tool chose the
   * 1-seeder release **while printing "leading on swarm health"**. Ranking and
   * then re-ranking is how a first key stops being first.
   */
  const r = await makeSearchEbook(async () =>
    json([
      prowlarrRelease({ title: 'Dune.epub', infoHash: HASH_A, seeders: 1 }),
      prowlarrRelease({ title: 'Dune.azw3', infoHash: HASH_B, seeders: 500 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(optionLine(r.content, 1), /Dune\.azw3/);
  assert.match(optionLine(r.content, 2), /Dune\.epub/, 'format is a key UNDER the band, not above it');
});

test('CONTROL: with the swarms level, the .epub wins — format still decides', async () => {
  const r = await makeSearchEbook(async () =>
    json([
      prowlarrRelease({ title: 'Dune.azw3', infoHash: HASH_B, seeders: 500 }),
      prowlarrRelease({ title: 'Dune.epub', infoHash: HASH_A, seeders: 500 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.match(optionLine(r.content, 1), /Dune\.epub/);
});

test('🔴 EBOOK: an archive does not outrank a real book on seeders alone', async () => {
  // Choosing something that IS a book used to happen when the model read the
  // list. `.rar` and `.epub` were the same bucket the moment the key was
  // epub-or-not, so a 90-seeder pack beat an 8-seeder azw3.
  const r = await makeSearchEbook(async () =>
    json([
      prowlarrRelease({ title: 'Dune.Complete.Series.rar', infoHash: HASH_A, seeders: 90 }),
      prowlarrRelease({ title: 'Dune.azw3', infoHash: HASH_B, seeders: 8 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.match(optionLine(r.content, 1), /Dune\.azw3/);
  assert.match(optionLine(r.content, 2), /\.rar/, 'the archive is ranked below a real book, not above it');
});

test('🔴 an IRC offer outranks a THIN torrent — a DCC transfer has no swarm to be dead', async () => {
  /**
   * The two sources used to be interleaved by position, so a one-seeder torrent
   * that happened to be an `.epub` was pushed ahead of a bot holding the book in
   * hand. An IRC offer is banded `healthy` on purpose: a bot either sends the
   * file or does not answer — there is no swarm for it to be thin.
   */
  const irc = {
    rosterHas: () => true,
    async search() {
      return {
        state: 'ok' as const,
        detail: 'found 1',
        results: [{ bot: 'Bsk', command: '!Bsk Dune.epub', title: 'Dune.epub', ext: '.epub', sizeBytes: 900_000 }],
      };
    },
    async fetch() {
      return { state: 'failed' as const, detail: 'not used here' };
    },
  } as unknown as IrcEbooks;

  const r = await makeSearchEbook(
    async () => json([prowlarrRelease({ title: 'Dune.epub', infoHash: HASH_A, seeders: 1 })]),
    irc,
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(optionLine(r.content, 1), /via IRC/, 'the bot outranks a swarm of one');
});

test('CONTROL: a HEALTHY torrent still beats the same IRC offer on the tiebreak', async () => {
  // Both land in the healthy band and both are .epub, so the seeder count breaks
  // the tie — which is what stops the IRC band from being an override.
  const irc = {
    rosterHas: () => true,
    async search() {
      return {
        state: 'ok' as const,
        detail: 'found 1',
        results: [{ bot: 'Bsk', command: '!Bsk Dune.epub', title: 'Dune.epub', ext: '.epub', sizeBytes: 900_000 }],
      };
    },
    async fetch() {
      return { state: 'failed' as const, detail: 'not used here' };
    },
  } as unknown as IrcEbooks;

  const r = await makeSearchEbook(
    async () => json([prowlarrRelease({ title: 'Dune.epub', infoHash: HASH_A, seeders: 400 })]),
    irc,
  ).run({ query: 'Dune' }, ctx());
  assert.match(optionLine(r.content, 1), /400 seeder/, 'the healthy torrent, not the bot');
  assert.match(optionLine(r.content, 2), /via IRC/);
});

test('🔴 a consumer that merely ACCEPTS a choice must still declare its kind', async () => {
  /**
   * The schema axis of the registry invariant read `required.includes('choice')`
   * — which was true of every consumer until this change emptied their `required`
   * lists so they could be called with no arguments. That left the rule matching
   * only `resolve_choice`, whose kind is `'*'` and is exempt: it fired for no
   * real tool in the repo while appearing to guard three. A rule that quietly
   * stops applying is worse than one that was never written.
   */
  const optionalChoice: Tool = {
    name: 'fake_optional_consumer',
    description: 'Takes an optional pick and declares nothing.',
    minRole: 'guest',
    writes: false,
    parameters: { type: 'object', properties: { choice: { type: 'number' } }, required: [] },
    run: async () => ({ ok: true, content: '' }),
  };
  assert.throws(
    () => assertChoiceProducersExist([optionalChoice]),
    /does not declare consumesChoiceKind/,
    'optional is still a dependency on a list some other tool stored',
  );
});

test('🔴 every candidate dead is ALL DEAD, which is not "nothing was found"', async () => {
  // Two different zeros. One of them means the book does not exist and the other
  // means every copy of it is unseeded, and only one is worth searching again for.
  const r = await makeSearchAudiobook(async () =>
    json([
      prowlarrRelease({ title: 'Dune A', infoHash: HASH_A, seeders: 0 }),
      prowlarrRelease({ title: 'Dune B', infoHash: HASH_B, seeders: 0 }),
    ]),
  ).run({ query: 'Dune' }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /ALL DEAD/);
  assert.match(r.content, /do not say nothing was found/i);
});

test('the prowlarr rankers lead on the band, not on the label', () => {
  const mk = (title: string, seeders: number): Release => ({
    title,
    protocol: 'torrent',
    infoHash: HASH_A,
    seeders,
    sizeBytes: 1,
    indexer: 'i',
  });
  assert.equal(rankReleases([mk('thin', 2), mk('healthy', 50)])[0]!.title, 'healthy');

  // The audiobook ranker had `graphicAudio matches` and `unabridged` ahead of
  // everything but a bare alive/dead test. A thin swarm now outranks both.
  const ranked = rankAudiobooks(
    [mk('Dune Unabridged', 2), mk('Dune abridged', 50)],
    { wantGraphicAudio: false },
  );
  assert.equal(ranked[0]!.title, 'Dune abridged', 'an abridged copy that exists beats one that does not');
});

// ── 🔴 THE SCOPE BOUNDARY: TITLE CHOICE IS STILL THEIRS ─────────────────────

test('🔴 ROBIN: an ambiguous TITLE still asks which work they meant', async () => {
  /**
   * 2026-08-26: Robin asked for *"Don't Say Good Luck"* and Jedd replied *"1.
   * the 2026 film, 2. the 2003 show — which did you mean?"* **That question was
   * right and must stay.** A film and a show sharing a name are different works;
   * choosing for someone downloads the wrong thing entirely, and no amount of
   * swarm health makes it the right one.
   *
   * This is proven by running the tool, not by reading it.
   */
  const path = tempFile();
  const fetchImpl: FetchImpl = async (url) =>
    String(url).includes('/radarr/')
      ? json([{ title: "Don't Say Good Luck", year: 2026, tmdbId: 111 }])
      : json([{ title: "Don't Say Good Luck", year: 2003, tvdbId: 222 }]);

  const r = await makeCatalogueSearch(fetchImpl).run(
    { title: "Don't Say Good Luck" },
    ctx({ choices: new ChoiceStore(path) }),
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /AMBIGUOUS/);
  assert.match(r.content, /2026/);
  assert.match(r.content, /2003/);
  assert.match(r.content, /^\s*\d+\.\s/m, 'a numbered choice — the one kind we still present');

  // And their answer resolves, so the flow completes rather than merely asking.
  const picked = await resolveChoice.run({ choice: 2 }, ctx({ choices: new ChoiceStore(path) }));
  assert.equal(picked.ok, true);
  assert.match(picked.content, /2003/);
  assert.match(picked.content, /"arr":"series"/);
});

test('CONTROL: the two flows are genuinely different code paths, not one rule read twice', () => {
  // `catalogue_search` presents `media-choice`; the release searches present
  // `release` / `sonarr-release`. If they ever shared a kind, silencing one
  // would silence the other, and the test above would stop being a guard.
  const catalogue = makeCatalogueSearch(async () => json([]));
  const episode = makeSearchEpisode(async () => json([]));
  assert.deepEqual(catalogue.presentsChoiceKinds, ['media-choice']);
  assert.deepEqual(episode.presentsChoiceKinds, ['sonarr-release']);
});

// ── the band itself ─────────────────────────────────────────────────────────

test('the swarm bands are dead / thin / healthy, and dead is anything not positive', () => {
  assert.equal(swarmHealth(0), 'dead');
  assert.equal(swarmHealth(-1), 'dead');
  assert.equal(swarmHealth(Number.NaN), 'dead', 'a missing seeder count is not evidence of health');
  assert.equal(swarmHealth(1), 'thin');
  assert.equal(swarmHealth(HEALTHY_SWARM_SEEDERS - 1), 'thin');
  assert.equal(swarmHealth(HEALTHY_SWARM_SEEDERS), 'healthy');
  assert.ok(swarmRank(HEALTHY_SWARM_SEEDERS) > swarmRank(1));
  assert.ok(swarmRank(1) > swarmRank(0));
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE PERSON ACTUALLY READS WHEN THE BOOK GENUINELY IS NOT THERE
 * ═══════════════════════════════════════════════════════════════════════════
 */

test('🔴 IRC "no matches" reaches the model as an ABSENCE, not as a bot that went quiet', async () => {
  /**
   * Live, 2026-08-27. Jeff asked for "Vengeance Is Mine: The Mountain Meadows
   * Massacre and Its Aftermath". SearchBot answered in 8.5s — no matches — and
   * Jedd, deaf to the notice it answered on, waited its full 90s cap and said:
   *
   *   "The search came back empty — the IRC ebooks bot didn't answer within
   *    90s, so nothing was found. That's a transient failure, not 'the book
   *    doesn't exist.' Want me to retry?"
   *
   * Both halves were wrong, and the second one is the expensive one: it sent him
   * back round a loop that could only fail the same way, and he did retry.
   *
   * 🔴 THIS ASSERTS ON THE WORDING THAT REACHES THE MODEL, which is the seam
   * where a `none` and an `unknown` stop being interchangeable. The IRC layer is
   * covered in `irc-sandbox.test.ts`; what this pins is that a `none` from IRC
   * merges into a REPORT OF ABSENCE naming both sources, instead of a report
   * that something failed to answer.
   */
  const irc = {
    rosterHas: () => true,
    async search() {
      return {
        state: 'none' as const,
        detail:
          'IRC found nothing — the #ebooks search bot searched and found no matches for ' +
          '"Vengeance Is Mine Richard E. Turley".',
      };
    },
    async fetch() {
      return { state: 'failed' as const, detail: 'not used here' };
    },
  } as unknown as IrcEbooks;

  const r = await makeSearchEbook(async () => json([]), irc).run(
    { query: 'Vengeance Is Mine Richard E. Turley' },
    ctx(),
  );

  assert.equal(r.ok, true);
  // 🪦 This used to assert `/NONE/`. Same contract, renamed head: see the
  // tombstone in `search-release.test.ts` on the NONE -> NOT FOUND rename.
  assert.match(r.content, /NOT FOUND/, 'both sources were read and both are empty');
  assert.match(r.content, /no matches/i, "the bot's own finding must survive the merge");
  assert.doesNotMatch(
    r.content,
    /did not answer|didn't answer|nothing arrived within/i,
    'reporting silence about a bot that spoke is the defect this closes',
  );
});
