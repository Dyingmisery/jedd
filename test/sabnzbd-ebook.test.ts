import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChoiceStore } from '../src/choices.js';
import { loadConfig } from '../src/config.js';
import {
  ebookAttemptCeiling,
  EBOOK_WAIT_BUDGET_MS,
  FollowupStore,
  MAX_ATTEMPTS,
} from '../src/followups.js';
import { runDueFollowups } from '../src/followup-runner.js';
import { KindleRegistry } from '../src/kindle.js';
import { localPathForStorage, readContainedBook } from '../src/media/sab-files.js';
import { SabnzbdClient, type FetchImpl } from '../src/media/sabnzbd.js';
import { makeSearchEbook } from '../src/tools/search-release.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const JEFF = '+18015550123';
const OTHER = '+13855550168';
const NZO = 'SABnzbd_nzo_testjob';
const SECRET = 'PROWLARRSECRET';
const SAB_KEY = 'sab-test-key';

/** A short EPUB the existing validator accepts. */
const EPUB = Buffer.concat([
  Buffer.from(
    '504b030414001608000047b9a3526f61ab2c1400000014000000080000006d696d6574797065' +
      Buffer.from('application/epub+zip', 'latin1').toString('hex'),
    'hex',
  ),
  Buffer.alloc(64, 0x41),
]);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const temp = () => mkdtempSync(join(tmpdir(), 'jedd-sab-'));

const duneWork = {
  docs: [
    {
      key: '/works/OL1W',
      title: 'Dune',
      author_name: ['Frank Herbert'],
      first_publish_year: 1965,
      edition_count: 10,
    },
  ],
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    role: 'guest',
    senderHandle: JEFF,
    config: testConfig({ readOnly: false }),
    choices: new ChoiceStore(join(temp(), 'choices.jsonl')),
    ...over,
  };
}

function withSab(dir: string) {
  return testConfig({
    readOnly: false,
    sabnzbd: {
      baseUrl: 'http://sab.invalid:8080',
      apiKey: SAB_KEY,
      category: 'jedd-ebooks',
      storagePrefix: '/library/ebooks',
      localDir: dir,
    },
  });
}

const nzb = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  protocol: 'usenet',
  downloadUrl: `http://prowlarr.invalid/api?apikey=${SECRET}&id=1`,
  indexer: 'NZBGeek',
  size: 2_000_000,
  ...extra,
});

// ── search: missing seeders are not a dead swarm ────────────────────────────

test('a Usenet row with no seeders is offered, and the model text has no key', async () => {
  const path = join(temp(), 'choices.jsonl');
  const r = await makeSearchEbook(
    async () => json([nzb('Frank Herbert - Dune.epub')]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ choices: new ChoiceStore(path), config: withSab('/no/such') }));
  assert.equal(r.ok, true);
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Usenet/);
  assert.match(r.content, /not a promise it will complete/);
  assert.doesNotMatch(r.content, /NO seeders/);
  assert.doesNotMatch(r.content, /ALL DEAD/);
  assert.equal(r.content.includes(SECRET), false);
  assert.equal(r.content.includes(SAB_KEY), false);
  const picked = new ChoiceStore(path).resolve(JEFF, 1);
  assert.equal(picked.ok, true);
  if (picked.ok) {
    assert.equal(picked.option.value['protocol'], 'usenet');
    assert.match(String(picked.option.value['downloadUrl']), /apikey=/);
  }
});

test('an explicit zero seeder count still does not kill a Usenet row', async () => {
  const r = await makeSearchEbook(
    async () => json([nzb('Frank Herbert - Dune.epub', { seeders: 0 })]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ config: withSab('/no/such') }));
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Usenet/);
  assert.doesNotMatch(r.content, /NO seeders/);
});

test('a zero-seeder torrent is still ALL DEAD', async () => {
  const r = await makeSearchEbook(
    async () =>
      json([
        { title: 'Frank Herbert - Dune.epub', protocol: 'torrent', infoHash: 'ab'.repeat(20), seeders: 0, size: 1000, indexer: 'x' },
      ]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ config: withSab('/no/such') }));
  assert.match(r.content, /^ALL DEAD/);
  assert.match(r.content, /NO seeders/);
});

test('a torrent row with the seeders field omitted is still a dead torrent', async () => {
  const r = await makeSearchEbook(
    async () => json([{ title: 'Frank Herbert - Dune.epub', infoHash: 'ab'.repeat(20), size: 1000, indexer: 'x' }]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx());
  assert.match(r.content, /^ALL DEAD/);
});

test('Usenet is held, not called unseeded, when SABnzbd is not configured', async () => {
  const r = await makeSearchEbook(
    async () => json([nzb('Frank Herbert - Dune.epub', { seeders: 0 })]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx());
  assert.match(r.content, /^USENET HELD/);
  assert.match(r.content, /SABNZBD_URL/);
  assert.doesNotMatch(r.content, /every one has NO seeders/);
  assert.doesNotMatch(r.content, /^ALL DEAD/);
  assert.equal(r.content.includes(SECRET), false);
});

test('a dead torrent plus a Usenet copy chooses Usenet when SABnzbd is configured', async () => {
  const r = await makeSearchEbook(
    async () =>
      json([
        { title: 'Frank Herbert - Dune.epub', protocol: 'torrent', infoHash: 'ab'.repeat(20), seeders: 0, size: 1000, indexer: 'x' },
        nzb('Dune by Frank Herbert.epub'),
      ]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ config: withSab('/no/such') }));
  assert.match(r.content, /^CHOSE — /);
  assert.match(r.content, /Usenet/);
  assert.doesNotMatch(r.content, /^ALL DEAD/);
});

test('a healthy torrent still outranks a Usenet copy of the same format', async () => {
  const r = await makeSearchEbook(
    async () =>
      json([
        nzb('Frank Herbert - Dune.epub'),
        {
          title: 'Frank Herbert - Dune.epub',
          protocol: 'torrent',
          infoHash: 'cd'.repeat(20),
          seeders: 40,
          size: 2_000_000,
          indexer: '1337x',
        },
      ]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ config: withSab('/no/such') }));
  assert.match(r.content, /healthiest swarm/);
  assert.match(r.content, /40 seeder/);
  assert.doesNotMatch(r.content, /I took that/);
});

test('a Usenet study guide is still not the book', async () => {
  const r = await makeSearchEbook(
    async () => json([nzb("Exploring Frank Herbert's Dune by Corey Olsen.epub")]),
    undefined,
    { fetchImpl: async () => json(duneWork) },
  ).run({ query: 'Dune Frank Herbert' }, ctx({ config: withSab('/no/such') }));
  assert.match(r.content, /^NOT THE BOOK/);
  assert.doesNotMatch(r.content, /Call send_ebook now/);
});

// ── SABnzbd client ───────────────────────────────────────────────────────────

function scripted(handler: (mode: string, url: URL, body: string) => unknown): { fetch: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchImpl = async (url, init) => {
    const raw = String(url);
    urls.push(raw);
    const parsed = new URL(raw);
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : '';
    return json(handler(parsed.searchParams.get('mode') ?? '', parsed, body));
  };
  return { fetch, urls };
}

test('addurl returns the nzo id and does not echo the api key', async () => {
  const { fetch, urls } = scripted((mode, _url, body) => {
    assert.equal(mode, 'addurl');
    assert.match(body, /cat=jedd-ebooks/);
    assert.equal(body.includes(SAB_KEY), false, 'the NZB form body is not the SABnzbd key');
    return { status: true, nzo_ids: [NZO] };
  });
  const added = await new SabnzbdClient({
    baseUrl: 'http://sab.invalid:8080',
    apiKey: SAB_KEY,
    category: 'jedd-ebooks',
    fetchImpl: fetch,
  }).addUrl(`http://prowlarr.invalid/get?apikey=${SECRET}`);
  assert.deepEqual(added, { state: 'accepted', nzoId: NZO });
  assert.equal(urls[0]?.includes(SAB_KEY), true, 'control: the request itself carries the key');
});

test('the readarr category is refused before any request', async () => {
  let called = 0;
  const fetch: FetchImpl = async () => {
    called += 1;
    return json({});
  };
  const added = await new SabnzbdClient({
    baseUrl: 'http://sab.invalid:8080',
    apiKey: SAB_KEY,
    category: 'readarr',
    fetchImpl: fetch,
  }).addUrl('http://prowlarr.invalid/nzb');
  assert.equal(added.state, 'rejected');
  assert.match(added.state === 'rejected' ? added.detail : '', /readarr/);
  assert.equal(called, 0);
});

test('an error body that quotes the NZB url is redacted', async () => {
  const { fetch } = scripted(() => ({ status: false, error: `failed http://prowlarr.invalid/get?apikey=${SECRET}` }));
  const added = await new SabnzbdClient({
    baseUrl: 'http://sab.invalid:8080',
    apiKey: SAB_KEY,
    category: 'jedd-ebooks',
    fetchImpl: fetch,
  }).addUrl(`http://prowlarr.invalid/get?apikey=${SECRET}`);
  assert.equal(added.state, 'rejected');
  assert.equal(JSON.stringify(added).includes(SECRET), false);
});

test('job state follows queue, then history, and Completed needs storage', async () => {
  const client = (slots: { queue?: unknown[]; history?: unknown[] }) =>
    new SabnzbdClient({
      baseUrl: 'http://sab.invalid:8080',
      apiKey: SAB_KEY,
      category: 'jedd-ebooks',
      fetchImpl: scripted((mode) =>
        mode === 'queue' ? { queue: { slots: slots.queue ?? [] } } : { history: { slots: slots.history ?? [] } },
      ).fetch,
    });

  const queued = await client({ queue: [{ nzo_id: NZO, status: 'Downloading' }] }).job(NZO);
  assert.deepEqual(queued, { state: 'queued', status: 'Downloading' });

  const done = await client({
    history: [{ nzo_id: NZO, status: 'Completed', storage: '/library/ebooks/Dune', fail_message: '' }],
  }).job(NZO);
  assert.deepEqual(done, { state: 'completed', storage: '/library/ebooks/Dune' });

  const bare = await client({ history: [{ nzo_id: NZO, status: 'Completed', storage: '' }] }).job(NZO);
  assert.equal(bare.state, 'incomplete');

  const failed = await client({
    history: [{ nzo_id: NZO, status: 'Failed', storage: '', fail_message: `no articles apikey=${SECRET}` }],
  }).job(NZO);
  assert.equal(failed.state, 'failed');
  assert.equal(JSON.stringify(failed).includes(SECRET), false);

  const missing = await client({}).job(NZO);
  assert.equal(missing.state, 'missing');
});

// ── path containment ─────────────────────────────────────────────────────────

test('storage outside the category prefix is refused, including a prefix trick', () => {
  const ok = localPathForStorage('/library/ebooks/Dune/Dune.epub', '/library/ebooks', '/ebooks');
  assert.deepEqual(ok, { ok: true, path: '/ebooks/Dune/Dune.epub' });
  assert.equal(localPathForStorage('/library/ebooks/../../etc/passwd', '/library/ebooks', '/ebooks').ok, false);
  assert.equal(localPathForStorage('/library/ebooks-evil/Dune.epub', '/library/ebooks', '/ebooks').ok, false);
  assert.equal(localPathForStorage('/library/other/Dune.epub', '/library/ebooks', '/ebooks').ok, false);
});

test('a contained epub is read, and an NZB or audiobook is not', async () => {
  const root = temp();
  mkdirSync(join(root, 'Dune'));
  writeFileSync(join(root, 'Dune', 'Dune.epub'), EPUB);
  writeFileSync(join(root, 'Dune', 'Dune.nzb'), 'nzb');
  writeFileSync(join(root, 'Dune', 'Dune.m4b'), Buffer.alloc(100));
  writeFileSync(join(root, 'Dune', 'notes.pdf'), Buffer.from('%PDF-tiny'));
  const book = await readContainedBook({
    storage: '/library/ebooks/Dune',
    storagePrefix: '/library/ebooks',
    localDir: root,
  });
  assert.equal(book.state, 'ok');
  if (book.state === 'ok') {
    assert.equal(book.filename, 'Dune.epub');
    assert.ok(book.bytes.equals(EPUB));
  }

  const onlyAudio = temp();
  writeFileSync(join(onlyAudio, 'book.m4b'), Buffer.alloc(20));
  writeFileSync(join(onlyAudio, 'book.nzb'), 'nzb');
  const skipped = await readContainedBook({
    storage: '/library/ebooks',
    storagePrefix: '/library/ebooks',
    localDir: onlyAudio,
  });
  assert.equal(skipped.state, 'absent');
});

test('a symlink that leaves the mount is not read', async () => {
  const root = temp();
  const outside = temp();
  const secret = Buffer.from('SECRET-OUTSIDE-BYTES');
  writeFileSync(join(outside, 'stolen.epub'), secret);
  symlinkSync(join(outside, 'stolen.epub'), join(root, 'Dune.epub'));
  const book = await readContainedBook({
    storage: '/library/ebooks/Dune.epub',
    storagePrefix: '/library/ebooks',
    localDir: root,
  });
  assert.equal(book.state, 'rejected');
  assert.equal(JSON.stringify(book).includes('SECRET-OUTSIDE-BYTES'), false);
});

test('an oversized book is not read', async () => {
  const root = temp();
  writeFileSync(join(root, 'big.epub'), Buffer.alloc(50));
  const book = await readContainedBook({
    storage: '/library/ebooks/big.epub',
    storagePrefix: '/library/ebooks',
    localDir: root,
    maxBytes: 10,
  });
  assert.equal(book.state, 'rejected');
  assert.match(book.state === 'rejected' ? book.detail : '', /limit/);
});

// ── acquisition, one submission, one mail, truthful notice ───────────────────

function presentUsenet(handle: string) {
  const choices = new ChoiceStore(join(temp(), 'choices.jsonl'));
  choices.present({
    senderHandle: handle,
    subject: 'Dune',
    kind: 'ebook-release',
    options: [
      {
        n: 1,
        label: 'Dune.epub — Usenet',
        value: {
          source: 'prowlarr',
          protocol: 'usenet',
          title: 'Dune.epub',
          downloadUrl: `http://prowlarr.invalid/get?apikey=${SECRET}`,
        },
      },
    ],
  });
  return choices;
}

test('send_ebook queues one NZB, stores the nzo id, and does not mail', async () => {
  const followups = new FollowupStore(join(temp(), 'followups.jsonl'));
  const kindle = new KindleRegistry(join(temp(), 'kindle.jsonl'));
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);
  let posts = 0;
  const mailed: unknown[] = [];
  const r = await makeSendEbook({
    send: async (m) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    sabFetch: async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get('mode'), 'addurl');
      posts += 1;
      assert.match(String(init?.body), new RegExp(SECRET));
      return json({ status: true, nzo_ids: [NZO] });
    },
  }).run(
    { choice: 1 },
    {
      ...ctx(),
      kindle,
      followups,
      choices: presentUsenet(JEFF),
      config: withSab(temp()),
    },
  );
  assert.equal(r.ok, true);
  assert.match(r.content, /NOTHING HAS BEEN SENT YET/);
  assert.equal(r.verbatimReply, 'Your request for Dune.epub has been added.');
  assert.match(r.content, /do not say it is on their Kindle/);
  assert.equal(r.content.includes(SECRET), false);
  assert.equal(r.content.includes(SAB_KEY), false);
  assert.equal(posts, 1);
  assert.equal(mailed.length, 0);
  const pending = followups.pendingEbook(JEFF, 'Dune.epub');
  assert.equal(pending?.ebook?.source, 'sab');
  assert.equal(pending?.ebook?.nzoId, NZO);

  const again = await makeSendEbook({
    send: async () => ({ messageId: 'x' }),
    sabFetch: async () => {
      posts += 1;
      return json({ status: true, nzo_ids: ['SABnzbd_nzo_second'] });
    },
  }).run(
    { choice: 1 },
    { ...ctx(), kindle, followups, choices: presentUsenet(JEFF), config: withSab(temp()) },
  );
  assert.equal(posts, 1, 'a second send must not submit another NZB');
  assert.match(again.content, /already being fetched/);
  assert.equal(again.verbatimReply, 'Your request for Dune.epub is already in.');
  assert.equal(mailed.length, 0);
});

test('writes disabled does not call SABnzbd', async () => {
  let called = 0;
  const r = await makeSendEbook({
    send: async () => ({ messageId: 'x' }),
    sabFetch: async () => {
      called += 1;
      return json({});
    },
  }).run(
    { choice: 1 },
    {
      ...ctx({ config: testConfig({ readOnly: true }) }),
      choices: presentUsenet(JEFF),
      kindle: new KindleRegistry(join(temp(), 'k.jsonl')),
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /Writes are disabled/);
  assert.equal(called, 0);
});

test('a restricted follow-up does not mail, and a failed job does not mail', async () => {
  const root = temp();
  mkdirSync(join(root, 'Dune'));
  writeFileSync(join(root, 'Dune', 'Dune.epub'), EPUB);
  const config = withSab(root);
  const kindle = new KindleRegistry(join(temp(), 'k.jsonl'));
  kindle.save(OTHER, 'readerone@kindle.com', ['readerone@kindle.com']);
  kindle.save(JEFF, 'owner@kindle.com', ['owner@kindle.com']);

  const restricted = new FollowupStore(join(temp(), 'f.jsonl'));
  restricted.schedule({
    kind: 'ebook-deliver',
    senderHandle: OTHER,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub" from Usenet for them',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: NZO },
  });
  const mailed: unknown[] = [];
  const spoke: string[] = [];
  await runDueFollowups(restricted, {
    config,
    kindle,
    onlySendTo: JEFF,
    send: async (_to, text) => {
      spoke.push(text);
    },
    mail: async (m) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    sabFetch: async () => json({ queue: { slots: [] }, history: { slots: [] } }),
  });
  assert.equal(mailed.length, 0);
  assert.match(spoke[0] ?? '', /Nothing was sent/);

  const failed = new FollowupStore(join(temp(), 'f2.jsonl'));
  const kindle2 = new KindleRegistry(join(temp(), 'k2.jsonl'));
  kindle2.save(JEFF, 'owner@kindle.com', ['owner@kindle.com']);
  failed.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub" from Usenet for them',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: NZO },
  });
  const spokeFail: string[] = [];
  await runDueFollowups(failed, {
    config,
    kindle: kindle2,
    send: async (_to, text) => {
      spokeFail.push(text);
    },
    mail: async (m) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    sabFetch: scripted((mode) =>
      mode === 'queue'
        ? { queue: { slots: [] } }
        : { history: { slots: [{ nzo_id: NZO, status: 'Failed', fail_message: 'no articles', storage: '' }] } },
    ).fetch,
  });
  assert.equal(mailed.length, 0);
  assert.match(spokeFail[0] ?? '', /could not email/i);
  assert.match(spokeFail[0] ?? '', /stopped trying/);
  assert.doesNotMatch(spokeFail[0] ?? '', /on its way to your Kindle/);
});

test('a completed job mails once, says the mail server accepted it, and a restart does not mail again', async () => {
  const root = temp();
  mkdirSync(join(root, 'Dune'));
  writeFileSync(join(root, 'Dune', 'Dune.epub'), EPUB);
  const path = join(temp(), 'followups.jsonl');
  const followups = new FollowupStore(path);
  const kindle = new KindleRegistry(join(temp(), 'k.jsonl'));
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);
  followups.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub" from Usenet for them',
    observed: 'SABnzbd accepted the NZB. Nothing has been mailed.',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: NZO },
  });
  const mailed: Array<{ to: string; text: string }> = [];
  const spoke: string[] = [];
  const fetch = scripted((mode) =>
    mode === 'queue'
      ? { queue: { slots: [] } }
      : {
          history: {
            slots: [{ nzo_id: NZO, status: 'Completed', storage: '/library/ebooks/Dune', fail_message: '' }],
          },
        },
  ).fetch;
  const deps = {
    config: withSab(root),
    kindle,
    send: async (_to: string, text: string) => {
      spoke.push(text);
    },
    mail: async (m: { to: string; text: string }) => {
      mailed.push(m);
      return { messageId: '<mail>' };
    },
    sabFetch: fetch,
  };
  const first = await runDueFollowups(followups, deps);
  assert.equal(first[0]?.sent, true);
  assert.equal(mailed.length, 1);
  assert.equal(mailed[0]?.to, 'readerone@kindle.com');
  assert.equal(spoke[0], 'Dune.epub has been emailed to your Kindle address.');
  assert.doesNotMatch(spoke[0] ?? '', /on its way|reached the device|arrived/i);
  assert.equal(spoke.join('\n').includes(SAB_KEY), false);

  const restarted = new FollowupStore(path);
  assert.equal(restarted.pendingEbook(JEFF, 'Dune.epub'), undefined, 'the finished job stays finished across a reload');
  const second = await runDueFollowups(restarted, deps);
  assert.equal(second.length, 0);
  assert.equal(mailed.length, 1, 'reloading the follow-up log must not send a second mail');
});

test('an ebook check waits about 30s and still budgets about 40 minutes', async () => {
  assert.equal(ebookAttemptCeiling(30_000) - 1, EBOOK_WAIT_BUDGET_MS / 30_000);
  const store = new FollowupStore(join(temp(), 'followups.jsonl'));
  const other = new FollowupStore(join(temp(), 'other.jsonl'));
  store.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(),
    reason: 'started fetching "Dune.epub" from Usenet for them',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: NZO },
  });
  other.schedule({
    kind: 'media-add',
    senderHandle: JEFF,
    dueAt: new Date(),
    reason: 'added a show',
    observed: 'queued',
    subject: { arr: 'series', id: 1, title: 'Example', seasons: [1] },
  });
  const ebookId = store.pendingEbook(JEFF, 'Dune.epub')!.id;
  const mediaId = other.all()[0]!.id;
  let ebookDefers = 0;
  while (store.defer(ebookId, new Date(), 'waiting', new Date(), ebookAttemptCeiling(30_000))) ebookDefers += 1;
  let mediaDefers = 0;
  while (other.defer(mediaId, new Date(), 'waiting')) mediaDefers += 1;
  assert.equal(mediaDefers, MAX_ATTEMPTS - 1);
  assert.ok(ebookDefers > MAX_ATTEMPTS);
  assert.equal(ebookDefers * 30_000, EBOOK_WAIT_BUDGET_MS);

  const root = temp();
  mkdirSync(join(root, 'Dune'));
  const path = join(temp(), 'pending.jsonl');
  const first = new FollowupStore(path);
  const kindle = new KindleRegistry(join(temp(), 'k.jsonl'));
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);
  const posts: string[] = [];
  const queued = scripted((mode) => {
    posts.push(mode);
    return { queue: { slots: [{ nzo_id: NZO, status: 'Downloading' }] } };
  }).fetch;
  await makeSendEbook({
    send: async () => ({ messageId: 'x' }),
    sabFetch: async () => {
      posts.push('addurl');
      return json({ status: true, nzo_ids: [NZO] });
    },
  }).run(
    { choice: 1 },
    {
      ...ctx(),
      kindle,
      followups: first,
      choices: presentUsenet(JEFF),
      config: withSab(root),
    },
  );
  const scheduled = first.pendingEbook(JEFF, 'Dune.epub');
  assert.ok(scheduled);
  assert.equal(scheduled?.ebook?.nzoId, NZO);
  assert.ok(Date.parse(scheduled!.dueAt) <= Date.now() + 1000);

  const restarted = new FollowupStore(path);
  const pending = restarted.pendingEbook(JEFF, 'Dune.epub');
  assert.equal(pending?.ebook?.nzoId, NZO);
  assert.equal(pending?.attempts, 0);
  const mailed: unknown[] = [];
  const spoke: string[] = [];
  const t0 = Date.parse(pending!.dueAt);
  const deps = {
    config: withSab(root),
    kindle,
    now: () => new Date(t0),
    send: async (_to: string, text: string) => {
      spoke.push(text);
    },
    mail: async (m: unknown) => {
      mailed.push(m);
      return { messageId: 'x' };
    },
    sabFetch: queued,
  };
  const submitsBeforePoll = posts.filter((mode) => mode === 'addurl').length;
  const looked = await runDueFollowups(restarted, deps, { kind: 'ebook-deliver' });
  assert.equal(looked[0]?.action, 'deferred');
  assert.equal(mailed.length, 0);
  assert.deepEqual(spoke, []);
  assert.equal(posts.filter((mode) => mode === 'addurl').length, submitsBeforePoll);
  const after = restarted.pendingEbook(JEFF, 'Dune.epub');
  assert.equal(after?.ebook?.nzoId, NZO);
  assert.equal(after?.attempts, 1);
  assert.equal(Date.parse(after!.dueAt) - t0, 30_000);

  const again = new FollowupStore(path);
  assert.equal(again.pendingEbook(JEFF, 'Dune.epub')?.attempts, 1);
  assert.equal(again.pendingEbook(JEFF, 'Dune.epub')?.ebook?.nzoId, NZO);
  const early = await runDueFollowups(again, { ...deps, now: () => new Date(t0 + 15_000) }, { kind: 'ebook-deliver' });
  assert.equal(early.length, 0);
  assert.equal(mailed.length, 0);
});

test('a faster ebook pass does not run a media follow-up', async () => {
  const store = new FollowupStore(join(temp(), 'mix.jsonl'));
  store.schedule({
    kind: 'media-add',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'added a show',
    observed: 'queued',
    subject: { arr: 'series', id: 7, title: 'Example Show', seasons: [1] },
  });
  store.schedule({
    kind: 'ebook-deliver',
    senderHandle: JEFF,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub" from Usenet for them',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: NZO },
  });
  const kindle = new KindleRegistry(join(temp(), 'k.jsonl'));
  kindle.save(JEFF, 'readerone@kindle.com', ['readerone@kindle.com']);
  await runDueFollowups(
    store,
    {
      config: withSab(temp()),
      kindle,
      send: async () => {},
      mail: async () => ({ messageId: 'x' }),
      sabFetch: async () => json({ queue: { slots: [{ nzo_id: NZO, status: 'Queued' }] } }),
    },
    { kind: 'ebook-deliver' },
  );
  assert.equal(store.all().find((f) => f.kind === 'media-add')?.attempts, 0);
  assert.equal(store.pendingEbook(JEFF, 'Dune.epub')?.attempts, 1);
});

test('loadConfig reads the SABnzbd variables and does not invent a URL', () => {
  const keys = [
    'SABNZBD_URL',
    'SABNZBD_API_KEY',
    'SABNZBD_CATEGORY',
    'SABNZBD_STORAGE_PREFIX',
    'SABNZBD_LOCAL_DIR',
    'EBOOK_RECHECK_MS',
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.SABNZBD_URL;
    delete process.env.SABNZBD_API_KEY;
    delete process.env.SABNZBD_CATEGORY;
    delete process.env.SABNZBD_STORAGE_PREFIX;
    delete process.env.SABNZBD_LOCAL_DIR;
    process.env.OWNER_HANDLE = process.env.OWNER_HANDLE || JEFF;
    const bare = loadConfig();
    assert.equal(bare.sabnzbd.baseUrl, '');
    assert.equal(bare.sabnzbd.apiKey, '');
    assert.equal(bare.sabnzbd.category, 'jedd-ebooks');
    assert.equal(bare.sabnzbd.storagePrefix, '');
    assert.equal(bare.sabnzbd.localDir, '');
    assert.equal(bare.ebookRecheckMs, 30_000);

    process.env.SABNZBD_URL = 'http://sab.invalid:8080/';
    process.env.SABNZBD_API_KEY = SAB_KEY;
    process.env.SABNZBD_LOCAL_DIR = '/ebooks';
    process.env.EBOOK_RECHECK_MS = '45000';
    const set = loadConfig();
    assert.equal(set.sabnzbd.baseUrl, 'http://sab.invalid:8080');
    assert.equal(set.sabnzbd.apiKey, SAB_KEY);
    assert.equal(set.sabnzbd.localDir, '/ebooks');
    assert.equal(set.sabnzbd.storagePrefix, '');
    assert.equal(set.ebookRecheckMs, 45_000);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
