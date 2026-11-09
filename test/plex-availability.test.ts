import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { replyToNumericMediaChoice } from '../src/media/media-request.js';
import { plexStatusLine } from '../src/media/plex.js';
import { makeAddMovie } from '../src/tools/add-media.js';
import { makePlexAvailability } from '../src/tools/plex-availability.js';
import type { FetchImpl } from '../src/media/arr.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const OWNER = '+18015550123';

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    role: 'owner',
    senderHandle: OWNER,
    config: testConfig({
      readOnly: false,
      plex: { baseUrl: 'http://plex.example:32400', token: 'plex-token' },
      services: { ...testConfig().services, plex: true },
    }),
    ...extra,
  };
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  } as unknown as Response;
}

function plexMovie(guid: string, hasFile: boolean) {
  return json({
    MediaContainer: {
      Metadata: [{ guid, title: 'Other Name', Media: hasFile ? [{ Part: [{ id: 1 }] }] : [] }],
    },
  });
}

test('an exact movie on Plex is one sentence and does not add', async () => {
  const posts: string[] = [];
  const r = await makePlexAvailability(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push(u);
    if (u.includes('/radarr/')) return json([{ title: 'Example Film', year: 2000, tmdbId: 77 }]);
    if (u.includes('/sonarr/')) return json([]);
    if (u.endsWith('/library/sections')) {
      return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
    }
    return plexMovie('tmdb://77', true);
  }).run({ query: 'Example Film', year: 2000 }, ctx());
  assert.equal(r.verbatimReply, 'Example Film (2000) is on Plex.');
  assert.deepEqual(posts, []);
});

test('a title hit with the wrong id is not on Plex', async () => {
  const r = await makePlexAvailability(async (url) => {
    const u = String(url);
    if (u.includes('/radarr/')) return json([{ title: 'Example Film', year: 2000, tmdbId: 77 }]);
    if (u.includes('/sonarr/')) return json([]);
    if (u.endsWith('/library/sections')) {
      return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
    }
    return plexMovie('imdb://tt000', true);
  }).run({ query: 'Example Film' }, ctx());
  assert.equal(r.verbatimReply, 'Example Film (2000) is not on Plex.');
});

test('a file-less match is not availability, and a Plex error is not a no', async () => {
  const missing = await makePlexAvailability(async (url) => {
    const u = String(url);
    if (u.includes('/radarr/')) return json([{ title: 'Example Film', year: 2000, tmdbId: 77 }]);
    if (u.includes('/sonarr/')) return json([]);
    if (u.endsWith('/library/sections')) {
      return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
    }
    return plexMovie('tmdb://77', false);
  }).run({ query: 'Example Film' }, ctx());
  assert.equal(missing.verbatimReply, 'Example Film (2000) is not on Plex.');

  const down = await makePlexAvailability(async (url) => {
    const u = String(url);
    if (u.includes('/radarr/')) return json([{ title: 'Example Film', year: 2000, tmdbId: 77 }]);
    if (u.includes('/sonarr/')) return json([]);
    return json({}, 500);
  }).run({ query: 'Example Film' }, ctx());
  assert.match(down.verbatimReply ?? '', /couldn't confirm/);
  assert.doesNotMatch(down.verbatimReply ?? '', /is not on Plex/);
});

test('an ambiguous title asks and a number checks that stored id only', async () => {
  const choices = new ChoiceStore(join(mkdtempSync(join(tmpdir(), 'jedd-px-')), 'c.jsonl'));
  const seen: string[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = String(url);
    seen.push(u);
    assert.notEqual(init?.method, 'POST');
    if (u.includes('/radarr/')) {
      return json([
        { title: 'Example', year: 1999, tmdbId: 1 },
        { title: 'Example', year: 2010, tmdbId: 2 },
      ]);
    }
    if (u.includes('/sonarr/')) return json([]);
    if (u.endsWith('/library/sections')) {
      return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
    }
    assert.match(u, /sections\/1\/all/);
    return plexMovie('tmdb://2', true);
  };
  const asked = await makePlexAvailability(fetchImpl).run({ query: 'Example' }, ctx({ choices }));
  assert.match(asked.verbatimReply ?? '', /Please confirm which movie you'd like me to check on Plex/);
  assert.match(asked.verbatimReply ?? '', /1\. Example \(1999\)/);
  assert.match(asked.verbatimReply ?? '', /2\. Example \(2010\)/);
  assert.equal(seen.some((u) => u.includes('/library/')), false);
  const reply = await replyToNumericMediaChoice('2', ctx({ choices }), {}, { fetchImpl });
  assert.equal(reply, 'Example (2010) is on Plex.');
  assert.equal(seen.filter((u) => u.includes('/lookup')).length, 2, 'the number does not search again');
});

test('a show answer names the season and ignores a future episode', () => {
  const line = plexStatusLine('Example Show', 2018, {
    state: 'series',
    seasons: [
      { seasonNumber: 1, status: 'ready' },
      { seasonNumber: 2, status: 'missing' },
      { seasonNumber: 3, status: 'unaired' },
    ],
  });
  assert.match(line, /Season 1 of Example Show \(2018\) is on Plex/);
  assert.match(line, /Season 2 of Example Show \(2018\) is not on Plex/);
  assert.doesNotMatch(line, /Season 3/);
  assert.doesNotMatch(line, /^Example Show .* is on Plex/);
});

test('a movie already in Radarr is checked on Plex and still not re-added', async () => {
  let posts = 0;
  const r = await makeAddMovie(async (url, init) => {
    const u = String(url);
    if (String(init?.method) === 'POST' && u.endsWith('/movie')) {
      posts += 1;
      return json([{ errorMessage: 'This movie has already been added' }], 400);
    }
    if (u.includes('/movie')) {
      return json([{ title: 'Example Film', tmdbId: 77, hasFile: true, id: 4 }]);
    }
    if (u.endsWith('/library/sections')) {
      return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }] } });
    }
    return plexMovie('tmdb://77', true);
  }).run({ tmdb_id: 77, title: 'Example Film', year: 2000 }, ctx());
  assert.equal(posts, 1);
  assert.match(r.verbatimReply ?? '', /already in the movie library/);
  assert.match(r.verbatimReply ?? '', /Example Film \(2000\) is on Plex/);
});

test('Plex unconfigured does not claim a library file is on Plex', async () => {
  const r = await makeAddMovie(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') return json([{ errorMessage: 'This movie has already been added' }], 400);
    if (u.includes('/radarr/')) return json([{ title: 'Example Film', tmdbId: 77, hasFile: true, id: 4 }]);
    throw new Error(`unexpected ${u}`);
  }).run(
    { tmdb_id: 77, title: 'Example Film', year: 2000 },
    { role: 'owner', senderHandle: OWNER, config: testConfig({ readOnly: false }) },
  );
  assert.match(r.verbatimReply ?? '', /already in the movie library/);
  assert.match(r.verbatimReply ?? '', /cannot check Plex/);
  assert.doesNotMatch(r.verbatimReply ?? '', /is on Plex/);
});
