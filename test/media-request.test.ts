import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { BlueBubblesClient } from '../src/bluebubbles/client.js';
import { ChoiceStore, CHOICE_TTL_MS } from '../src/choices.js';
import { FollowupStore, MAX_ATTEMPTS } from '../src/followups.js';
import { runDueFollowups } from '../src/followup-runner.js';
import { replyToNumericMediaChoice } from '../src/media/media-request.js';
import { PlexClient, seasonsReady } from '../src/media/plex.js';
import { allowedPosterUrl, fetchAllowlistedPoster } from '../src/media/poster.js';
import { makeAddMovie, makeAddSeries } from '../src/tools/add-media.js';
import { makeCatalogueSearch } from '../src/tools/catalogue.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const OWNER = '+18015550123';

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    role: 'owner',
    senderHandle: OWNER,
    config: testConfig({ readOnly: false }),
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as Response;
}

test('exact film and exact show do not ask, and do not invent a poster', async () => {
  const images: string[] = [];
  const r = await makeCatalogueSearch(async (url) => {
    const u = String(url);
    if (u.includes('/radarr/')) return jsonResponse([{ title: 'Whiplash', year: 2014, tmdbId: 244786 }]);
    return jsonResponse([]);
  }).run({ title: 'whiplash' }, ctx({ sendImage: async (name) => {
    images.push(name);
    return true;
  } }));
  assert.match(r.content, /^FILM/);
  assert.equal(r.verbatimReply, undefined);
  assert.deepEqual(images, []);

  const show = await makeCatalogueSearch(async (url) => {
    const u = String(url);
    if (u.includes('/radarr/')) return jsonResponse([]);
    return jsonResponse([{ title: 'Breaking Bad', year: 2008, tvdbId: 1396 }]);
  }).run({ title: 'breaking bad' }, ctx());
  assert.match(show.content, /^SHOW/);
  assert.equal(show.verbatimReply, undefined);
});

test('ambiguous movie and show asks with numbers, years, and posters in that order', async () => {
  const sent: string[] = [];
  const fetched: string[] = [];
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  const r = await makeCatalogueSearch(async (url, init) => {
    const u = String(url);
    fetched.push(u);
    if (u.includes('image.tmdb.org') || u.includes('artworks.thetvdb.com')) {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['X-Api-Key'], undefined);
      assert.equal(headers?.['X-Plex-Token'], undefined);
      assert.doesNotMatch(u, /apikey=/i);
    }
    if (u.includes('/radarr/')) {
      return jsonResponse([
        {
          title: 'Moneyball',
          year: 2011,
          tmdbId: 60308,
          remotePoster: 'https://image.tmdb.org/t/p/w500/film.jpg',
          images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://image.tmdb.org/t/p/w500/ignored.jpg' }],
        },
      ]);
    }
    return jsonResponse([
      {
        title: 'Moneyball',
        year: 2021,
        tvdbId: 99,
        images: [{ coverType: 'poster', remoteUrl: 'https://artworks.thetvdb.com/banners/show.jpg' }],
      },
    ]);
  }).run(
    { title: 'moneyball' },
    ctx({
      choices,
      sendImage: async (name) => {
        sent.push(name);
        return true;
      },
    }),
  );
  assert.match(r.verbatimReply ?? '', /Please confirm which movie or show/);
  assert.match(r.verbatimReply ?? '', /1\. Moneyball \(2011\).*movie/);
  assert.match(r.verbatimReply ?? '', /2\. Moneyball \(2021\).*show/);
  assert.deepEqual(sent, ['1.jpg', '2.jpg']);
  assert.ok(fetched.some((u) => u.endsWith('/film.jpg')));
  assert.ok(fetched.some((u) => u.endsWith('/show.jpg')));
  assert.equal(fetched.some((u) => u.includes('/MediaCover/')), false);
  const pending = choices.pending(OWNER);
  assert.equal((pending?.options[0]?.value as { id: number }).id, 60308);
  assert.equal((pending?.options[1]?.value as { id: number }).id, 99);
});

test('a missing poster stops later images and still asks', async () => {
  const sent: string[] = [];
  const r = await makeCatalogueSearch(async (url) => {
    const u = String(url);
    if (u.includes('image.tmdb.org')) return jsonResponse('nope', 404);
    if (u.includes('/radarr/')) {
      return jsonResponse([
        { title: 'Dune', year: 2021, tmdbId: 1, remotePoster: 'https://image.tmdb.org/t/p/w500/one.jpg' },
        { title: 'Dune', year: 1984, tmdbId: 2, remotePoster: 'https://image.tmdb.org/t/p/w500/two.jpg' },
      ]);
    }
    return jsonResponse([]);
  }).run(
    { title: 'dune' },
    ctx({
      sendImage: async (name) => {
        sent.push(name);
        return true;
      },
    }),
  );
  assert.match(r.verbatimReply ?? '', /1\. Dune \(2021\)/);
  assert.match(r.verbatimReply ?? '', /2\. Dune \(1984\)/);
  assert.deepEqual(sent, [], 'a failed first image must not be followed by the second');
});

test('an attachment failure does not shift later posters onto an earlier number', async () => {
  const sent: string[] = [];
  const r = await makeCatalogueSearch(async (url) => {
    const u = String(url);
    if (u.includes('image.tmdb.org')) return jsonResponse({ ok: true });
    if (u.includes('/radarr/')) {
      return jsonResponse([
        { title: 'Dune', year: 2021, tmdbId: 1, remotePoster: 'https://image.tmdb.org/t/p/w500/one.jpg' },
        { title: 'Dune', year: 1984, tmdbId: 2, remotePoster: 'https://image.tmdb.org/t/p/w500/two.jpg' },
        { title: 'Dune', year: 2000, tmdbId: 3, remotePoster: 'https://image.tmdb.org/t/p/w500/three.jpg' },
      ]);
    }
    return jsonResponse([]);
  }).run(
    { title: 'dune' },
    ctx({
      sendImage: async (name) => {
        sent.push(name);
        return name !== '1.jpg';
      },
    }),
  );
  assert.deepEqual(sent, ['1.jpg']);
  assert.match(r.verbatimReply ?? '', /3\. Dune \(2000\)/);
});

test('poster fetch stays on the allowlist and drops redirects and api keys', async () => {
  assert.equal(allowedPosterUrl('https://image.tmdb.org/t/p/w500/a.jpg'), true);
  assert.equal(allowedPosterUrl('https://artworks.thetvdb.com/banners/a.jpg'), true);
  assert.equal(allowedPosterUrl('http://image.tmdb.org/a.jpg'), false);
  assert.equal(allowedPosterUrl('https://image.tmdb.org/a.jpg?apikey=secret'), false);
  assert.equal(allowedPosterUrl('https://evil.example/a.jpg'), false);
  const seen: string[] = [];
  const bytes = await fetchAllowlistedPoster('https://image.tmdb.org/t/p/w500/a.jpg', async (url) => {
    seen.push(String(url));
    if (seen.length === 1) return jsonResponse('', 302, { location: 'https://evil.example/stolen.jpg' });
    return jsonResponse('no');
  });
  assert.equal(bytes, null);
  assert.deepEqual(seen, ['https://image.tmdb.org/t/p/w500/a.jpg']);
});

test('a numbered reply adds the stored movie and does not search again', async () => {
  const posts: unknown[] = [];
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  const followups = new FollowupStore(join(dir('jedd-fu-'), 'f.jsonl'));
  choices.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    options: [
      { n: 1, label: 'old', value: { arr: 'movie', id: 111, title: 'Dune', year: 1984 } },
      { n: 2, label: 'new', value: { arr: 'movie', id: 222, title: 'Dune', year: 2021 } },
    ],
  });
  const tool = makeAddMovie(async (url, init) => {
    const u = String(url);
    assert.equal(u.includes('/lookup'), false);
    posts.push(JSON.parse(String(init?.body)));
    return jsonResponse({ id: 1 });
  });
  const c = ctx({ choices, followups });
  const reply = await replyToNumericMediaChoice('2', c, { addMovie: tool });
  assert.equal(reply, 'Your request for Dune (2021) has been added.');
  assert.equal((posts[0] as { tmdbId: number }).tmdbId, 222);
  const again = await replyToNumericMediaChoice('2', c, { addMovie: tool });
  assert.match(again ?? '', /already in/);
  assert.equal(posts.length, 1);
});

test('a stale or invalid number adds nothing', async () => {
  let posts = 0;
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  choices.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    now: new Date(Date.now() - CHOICE_TTL_MS - 1000),
    options: [{ n: 1, label: 'old', value: { arr: 'movie', id: 111, title: 'Dune', year: 1984 } }],
  });
  const tool = makeAddMovie(async () => {
    posts += 1;
    return jsonResponse({ id: 1 });
  });
  const stale = await replyToNumericMediaChoice('1', ctx({ choices }), { addMovie: tool });
  assert.match(stale ?? '', /expired/);
  const fresh = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  fresh.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    options: [{ n: 1, label: 'old', value: { arr: 'movie', id: 111, title: 'Dune', year: 1984 } }],
  });
  const bad = await replyToNumericMediaChoice('9', ctx({ choices: fresh }), { addMovie: tool });
  assert.match(bad ?? '', /not on the list/);
  assert.equal(posts, 0);
});

test('a numbered show is pinned and a later add uses that id, not a new search', async () => {
  const posts: unknown[] = [];
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  choices.present({
    senderHandle: OWNER,
    subject: 'The Office',
    kind: 'media-choice',
    options: [
      { n: 1, label: 'uk', value: { arr: 'series', id: 10, title: 'The Office', year: 2001 } },
      { n: 2, label: 'us', value: { arr: 'series', id: 20, title: 'The Office', year: 2005 } },
    ],
  });
  const asked = await replyToNumericMediaChoice('2', ctx({ choices }), {});
  assert.equal(asked, 'Which seasons of The Office (2005) should I add?');
  const tool = makeAddSeries(async (_url, init) => {
    if (init?.body) posts.push(JSON.parse(String(init.body)));
    return jsonResponse({});
  });
  const added = await tool.run(
    { tvdb_id: 99999, title: 'Wrong', seasons: [1], available_seasons: [1, 2] },
    ctx({ choices }),
  );
  assert.equal(added.verbatimReply, 'Your request for The Office (2005), season 1, has been added.');
  assert.equal((posts[0] as { tvdbId: number }).tvdbId, 20);
  assert.equal(posts.length, 1);
});

test('an open list is not auto-picked, and a read-only config does not add', async () => {
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  choices.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    options: [
      { n: 1, label: 'a', value: { arr: 'movie', id: 1, title: 'Dune', year: 1984 } },
      { n: 2, label: 'b', value: { arr: 'movie', id: 2, title: 'Dune', year: 2021 } },
    ],
  });
  let posts = 0;
  const tool = makeAddMovie(async () => {
    posts += 1;
    return jsonResponse({ id: 1 });
  });
  const blocked = await tool.run({ tmdb_id: 1, title: 'Dune' }, ctx({ choices }));
  assert.match(blocked.content, /still open/);
  const readonly = await replyToNumericMediaChoice(
    '1',
    ctx({ choices, config: testConfig({ readOnly: true }) }),
    { addMovie: tool },
  );
  assert.match(readonly ?? '', /nothing was added/i);
  assert.equal(posts, 0);
});

test('a bare number does not call the model', async () => {
  const choices = new ChoiceStore(join(dir('jedd-ch-'), 'c.jsonl'));
  const followups = new FollowupStore(join(dir('jedd-fu-'), 'f.jsonl'));
  choices.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    options: [{ n: 1, label: 'new', value: { arr: 'movie', id: 222, title: 'Dune', year: 2021 } }],
  });
  const agent = new Agent(
    testConfig({ readOnly: false }),
    { label: 'test', chat: async () => { throw new Error('model was called'); } },
    undefined,
    [makeAddMovie(async () => jsonResponse({ id: 1 }))],
    undefined,
    followups,
    choices,
  );
  const turn = await agent.handle(OWNER, '1');
  assert.equal(turn.replyText, 'Your request for Dune (2021) has been added.');
  await assert.rejects(() => agent.handle(OWNER, 'the first one'), /model was called/);
});

test('plex requires the guid and a media file, and ignores a title hit', async () => {
  const urls: string[] = [];
  const client = new PlexClient({
    baseUrl: 'http://plex.example:32400',
    token: 'plex-token',
    fetchImpl: async (url, init) => {
      const u = String(url);
      urls.push(u);
      assert.equal(u.includes('plex-token'), false);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers['X-Plex-Token'], 'plex-token');
      if (u.endsWith('/library/sections')) {
        return jsonResponse({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
      }
      return jsonResponse({
        MediaContainer: {
          Metadata: [
            { title: 'Dune', guid: 'imdb://tt0087182', Media: [{ Part: [{ id: 1 }] }] },
            { title: 'Something Else', guid: 'tmdb://222' },
          ],
        },
      });
    },
  });
  const mismatch = await client.available({ arr: 'movie', id: 222, seasons: [], now: new Date('2026-01-01') });
  assert.equal(mismatch.state, 'not-ready');
  const ready = new PlexClient({
    baseUrl: 'http://plex.example:32400',
    token: 'plex-token',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/library/sections')) {
        return jsonResponse({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
      }
      return jsonResponse({
        MediaContainer: { Metadata: [{ guid: 'tmdb://222', Media: [{ Part: [{ id: 1 }] }] }] },
      });
    },
  });
  assert.equal((await ready.available({ arr: 'movie', id: 222, seasons: [], now: new Date() })).state, 'ready');
  assert.ok(urls.length > 0);
});

test('a plex redirect off the configured host is not followed', async () => {
  const seen: string[] = [];
  const client = new PlexClient({
    baseUrl: 'http://plex.example:32400',
    token: 'plex-token',
    fetchImpl: async (url) => {
      seen.push(String(url));
      return jsonResponse('', 302, { location: 'http://evil.example/library/sections' });
    },
  });
  const view = await client.available({ arr: 'movie', id: 1, seasons: [], now: new Date() });
  assert.equal(view.state, 'unknown');
  assert.deepEqual(seen, ['http://plex.example:32400/library/sections']);
});

test('tv scope ignores future episodes and does not treat one season as the whole show', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const seasons = [
    {
      seasonNumber: 1,
      episodes: [
        { airedAt: '2026-01-01', hasFile: true },
        { airedAt: '2026-12-01', hasFile: false },
      ],
    },
    {
      seasonNumber: 2,
      episodes: [{ airedAt: '2026-02-01', hasFile: false }],
    },
  ];
  assert.equal(seasonsReady([1], seasons, now), true);
  assert.equal(seasonsReady([1, 2], seasons, now), false);
  assert.equal(
    seasonsReady([2], [{ seasonNumber: 2, episodes: [{ airedAt: '2026-12-01', hasFile: false }] }], now),
    false,
  );
});

test('a season is available only when every aired episode has a file', async () => {
  const client = new PlexClient({
    baseUrl: 'http://plex.example:32400',
    token: 'plex-token',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/library/sections')) {
        return jsonResponse({ MediaContainer: { Directory: [{ key: '2', type: 'show' }] } });
      }
      if (u.includes('/allLeaves')) {
        return jsonResponse({
          MediaContainer: {
            Metadata: [
              { parentIndex: 1, originallyAvailableAt: '2020-01-01', Media: [{ Part: [{ id: 1 }] }] },
              { parentIndex: 1, originallyAvailableAt: '2020-01-08' },
            ],
          },
        });
      }
      return jsonResponse({
        MediaContainer: { Metadata: [{ ratingKey: '9', Guid: [{ id: 'tvdb://20' }], title: 'Not The Requested Show' }] },
      });
    },
  });
  const partial = await client.available({ arr: 'series', id: 20, seasons: [1], now: new Date('2026-01-01') });
  assert.equal(partial.state, 'not-ready');
});

async function mediaRun(
  plex: { available: () => Promise<{ state: 'ready' | 'not-ready' | 'unknown' }> } | undefined,
  counts: Record<number, [number, number]>,
) {
  const s = new FollowupStore(join(dir('jedd-mf-'), 'f.jsonl'));
  s.schedule({
    kind: 'media-add',
    senderHandle: OWNER,
    dueAt: new Date(Date.now() - 1000),
    reason: 'added Example Show',
    observed: 'accepted',
    subject: { arr: 'series', id: 20, title: 'Example Show', seasons: [1] },
  });
  const sent: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse([
      {
        title: 'Example Show',
        tvdbId: 20,
        seasons: Object.entries(counts).map(([n, [got, tot]]) => ({
          seasonNumber: Number(n),
          statistics: { episodeFileCount: got, totalEpisodeCount: tot },
        })),
      },
    ])) as typeof fetch;
  try {
    const out = await runDueFollowups(s, {
      config: testConfig(),
      send: async (_to, text) => {
        sent.push(text);
      },
      ...(plex ? { plex } : {}),
    });
    return { out, sent, s };
  } finally {
    globalThis.fetch = orig;
  }
}

test('arr completion is not a plex announcement, and a real match is one sentence', async () => {
  const quiet = await mediaRun({ available: async () => ({ state: 'not-ready' }) }, { 1: [10, 10] });
  assert.equal(quiet.sent.length, 0);
  assert.match(quiet.out[0]!.detail, /not on plex/);
  const announced = await mediaRun({ available: async () => ({ state: 'ready' }) }, { 1: [0, 10] });
  assert.deepEqual(announced.sent, ['Season 1 of Example Show is now available on Plex.']);
  const again = await runDueFollowups(announced.s, {
    config: testConfig(),
    send: async (_to, text) => {
      announced.sent.push(text);
    },
    plex: { available: async () => ({ state: 'ready' }) },
  });
  assert.equal(again.length, 0);
  assert.equal(announced.sent.length, 1);
});

test('plex timeout and a long wait each speak once and never claim availability', async () => {
  const unknown = await mediaRun({ available: async () => ({ state: 'unknown' }) }, { 1: [10, 10] });
  assert.equal(unknown.sent.length, 0);
  const sent: string[] = [];
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    for (const f of unknown.s.all()) if (f.status === 'pending') f.dueAt = new Date(Date.now() - 1000).toISOString();
    await runDueFollowups(unknown.s, {
      config: testConfig(),
      send: async (_to, text) => {
        sent.push(text);
      },
      plex: { available: async () => ({ state: 'unknown' }) },
    });
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /couldn't confirm/);
  assert.doesNotMatch(sent[0]!, /available on Plex/);

  const waiting = await mediaRun({ available: async () => ({ state: 'not-ready' }) }, { 1: [1, 10] });
  const late: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    jsonResponse([
      {
        title: 'Example Show',
        tvdbId: 20,
        seasons: [{ seasonNumber: 1, statistics: { episodeFileCount: 1, totalEpisodeCount: 10 } }],
      },
    ])) as typeof fetch;
  try {
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      for (const f of waiting.s.all()) if (f.status === 'pending') f.dueAt = new Date(Date.now() - 1000).toISOString();
      await runDueFollowups(waiting.s, {
        config: testConfig(),
        send: async (_to, text) => {
          late.push(text);
        },
        plex: { available: async () => ({ state: 'not-ready' }) },
      });
    }
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(late.length, 1);
  assert.match(late[0]!, /Some of it arrived/);
  assert.doesNotMatch(late[0]!, /available on Plex/);
});

test('a stored choice survives a new store on the same file', async () => {
  const path = join(dir('jedd-ch-'), 'c.jsonl');
  const first = new ChoiceStore(path);
  first.present({
    senderHandle: OWNER,
    subject: 'Dune',
    kind: 'media-choice',
    options: [{ n: 1, label: 'new', value: { arr: 'movie', id: 222, title: 'Dune', year: 2021 } }],
  });
  const second = new ChoiceStore(path);
  const reply = await replyToNumericMediaChoice(
    '1',
    ctx({ choices: second, followups: new FollowupStore(join(dir('jedd-fu-'), 'f.jsonl')) }),
    { addMovie: makeAddMovie(async () => jsonResponse({ id: 1 })) },
  );
  assert.equal(reply, 'Your request for Dune (2021) has been added.');
});

test('bluebubbles attachment uses apple-script and does not carry an arr key', async () => {
  let method = '';
  let url = '';
  const client = new BlueBubblesClient({
    baseUrl: 'http://bluebubbles.invalid:1234',
    password: 'test-pw',
    fetchImpl: async (input, init) => {
      url = String(input);
      if (url.includes('/chat/query')) return jsonResponse({ data: [] });
      const form = init?.body as FormData;
      method = String(form.get('method'));
      return jsonResponse({ data: { guid: 'g' } });
    },
  });
  const result = await client.sendAttachment(OWNER, '1.jpg', Buffer.from([1, 2, 3]));
  assert.equal(result.accepted, true);
  assert.equal(method, 'apple-script');
  assert.match(url, /\/message\/attachment/);
  assert.doesNotMatch(url, /radarr|apikey=secret/i);
});
