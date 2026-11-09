import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { ChoiceStore } from '../src/choices.js';
import { FollowupStore } from '../src/followups.js';
import { KindleRegistry } from '../src/kindle.js';
import { runDueFollowups } from '../src/followup-runner.js';
import { parseSendAudience } from '../src/bluebubbles/receiver.js';
import { mayRequestKindle, roleFor } from '../src/permissions.js';
import { hpShell } from '../src/tools/homelab.js';
import { kindleStatus, saveKindleEmail } from '../src/tools/kindle.js';
import { makeSearchEbook } from '../src/tools/search-release.js';
import { makeSendEbook } from '../src/tools/send-ebook.js';
import type { ToolContext } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

const OWNER = '+18015550123';
const PERMITTED = '+18015550199';
const UNLISTED = '+18015550188';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'jedd-ks-'));
}

function cfg(extra: { senders?: string[] } = {}) {
  return testConfig({
    readOnly: false,
    ownerHandle: OWNER,
    kindleSenders: extra.senders ?? [],
    sabnzbd: {
      baseUrl: 'http://sab.invalid',
      apiKey: 'test-key',
      category: 'jedd-ebooks',
      storagePrefix: '/library/ebooks',
      localDir: '/ebooks',
    },
  });
}

function ctx(handle: string, config = cfg(), kindle?: KindleRegistry): ToolContext {
  return {
    role: roleFor(handle, config),
    senderHandle: handle,
    config,
    kindle: kindle ?? new KindleRegistry(join(dir(), 'k.jsonl')),
    choices: new ChoiceStore(join(dir(), 'c.jsonl')),
    userTurns: [],
  };
}

test('the owner may request ebooks; an unlisted guest may not; the send audience is separate', () => {
  const open = cfg();
  assert.equal(mayRequestKindle(OWNER, open), true);
  assert.equal(mayRequestKindle(PERMITTED, open), false);
  assert.equal(mayRequestKindle(UNLISTED, open), false);
  const listed = cfg({ senders: [PERMITTED] });
  assert.equal(mayRequestKindle(PERMITTED, listed), true);
  assert.equal(mayRequestKindle(UNLISTED, listed), false);
  assert.equal(roleFor(PERMITTED, listed), 'guest');
  const audience = parseSendAudience(OWNER);
  assert.equal(audience.includes(PERMITTED), false);
});

test('an unlisted guest cannot search or send, and no request is made', async () => {
  let looked = 0;
  const search = await makeSearchEbook(async () => {
    looked += 1;
    return { ok: true, status: 200, text: async () => '[]' } as Response;
  }).run({ query: 'Dune' }, ctx(UNLISTED, cfg({ senders: [PERMITTED] })));
  assert.equal(search.ok, false);
  assert.match(search.content, /not enabled/);
  assert.equal(looked, 0);

  let grabbed = 0;
  const sent = await makeSendEbook({
    send: async () => {
      grabbed += 1;
      return { messageId: 'x' };
    },
  }).run({ choice: 1, address: 'other@kindle.com' }, ctx(UNLISTED, cfg({ senders: [PERMITTED] })));
  assert.equal(sent.ok, false);
  assert.match(sent.content, /not enabled/);
  assert.equal(grabbed, 0);
});

test('a permitted guest emails the owner address and cannot replace it', async () => {
  const kindle = new KindleRegistry(join(dir(), 'k.jsonl'));
  kindle.save(OWNER, 'household@kindle.com', ['household@kindle.com']);
  kindle.save(PERMITTED, 'other@kindle.com', ['other@kindle.com']);
  const config = cfg({ senders: [PERMITTED] });
  const saved = await saveKindleEmail.run(
    { address: 'other@kindle.com' },
    { ...ctx(PERMITTED, config, kindle), userTurns: ['other@kindle.com'] },
  );
  assert.equal(saved.ok, false);
  assert.match(saved.content, /cannot set the Kindle address/);
  assert.equal(kindle.get(OWNER)?.address, 'household@kindle.com');

  const status = await kindleStatus.run({}, ctx(PERMITTED, config, kindle));
  assert.equal(status.ok, true);
  assert.doesNotMatch(status.content, /household@kindle.com/);
  assert.match(status.content, /cannot change it/);

  const choices = new ChoiceStore(join(dir(), 'c.jsonl'));
  choices.present({
    senderHandle: PERMITTED,
    subject: 'Dune',
    kind: 'ebook-release',
    options: [{
      n: 1,
      label: 'Dune',
      value: { protocol: 'usenet', title: 'Dune.epub', downloadUrl: 'http://prowlarr.invalid/nzb' },
    }],
  });
  choices.present({
    senderHandle: OWNER,
    subject: 'Other',
    kind: 'ebook-release',
    options: [{ n: 1, label: 'Other', value: { source: 'sab', title: 'Other.epub', downloadUrl: 'http://prowlarr.invalid/other' } }],
  });
  const mailed: string[] = [];
  const followups = new FollowupStore(join(dir(), 'f.jsonl'));
  const queued = await makeSendEbook({
    send: async (m) => {
      mailed.push(m.to);
      return { messageId: 'x' };
    },
    sabFetch: async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify({ status: true, nzo_ids: ['nzo1'] }) }) as Response,
  }).run({ choice: 1, address: 'other@kindle.com' }, { ...ctx(PERMITTED, config, kindle), choices, followups });
  assert.equal(queued.verbatimReply, 'Your request for Dune.epub has been added.');
  assert.equal(mailed.length, 0);
  assert.equal(followups.pendingEbook(OWNER, 'Dune.epub'), undefined);
  assert.equal(followups.pendingEbook(PERMITTED, 'Dune.epub')?.ebook?.nzoId, 'nzo1');
});

test('a permitted guest follow-up mails once, and a removed sender does not', async () => {
  const root = dir();
  const path = join(root, 'f.jsonl');
  const store = new FollowupStore(path);
  store.schedule({
    kind: 'ebook-deliver',
    senderHandle: PERMITTED,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub"',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: 'nzo1' },
  });
  const kindle = new KindleRegistry(join(root, 'k.jsonl'));
  kindle.save(OWNER, 'household@kindle.com', ['household@kindle.com']);
  const mailed: string[] = [];
  const spoke: string[] = [];
  const sab = async () =>
    ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          queue: { slots: [] },
          history: { slots: [{ nzo_id: 'nzo1', status: 'Failed', fail_message: 'no articles', storage: '' }] },
        }),
    }) as Response;
  // Failure path proves the follow-up runs for the permitted guest and does not mail.
  await runDueFollowups(store, {
    config: cfg({ senders: [PERMITTED] }),
    kindle,
    send: async (_to, text) => {
      spoke.push(text);
    },
    mail: async (m) => {
      mailed.push(m.to);
      return { messageId: 'x' };
    },
    sabFetch: sab,
  });
  assert.equal(mailed.length, 0);
  assert.match(spoke[0] ?? '', /could not email Dune\.epub/);
  assert.match(spoke[0] ?? '', /Nothing was sent/);

  const pending = new FollowupStore(join(root, 'pending.jsonl'));
  pending.schedule({
    kind: 'ebook-deliver',
    senderHandle: PERMITTED,
    dueAt: new Date(Date.now() - 1000),
    reason: 'started fetching "Dune.epub"',
    observed: 'queued',
    ebook: { source: 'sab', title: 'Dune.epub', nzoId: 'nzo1' },
  });
  let fetches = 0;
  const blocked = await runDueFollowups(pending, {
    config: cfg(),
    kindle,
    send: async () => {},
    mail: async (m) => {
      mailed.push(m.to);
      return { messageId: 'x' };
    },
    sabFetch: async () => {
      fetches += 1;
      return sab();
    },
  });
  assert.equal(fetches, 0);
  assert.equal(mailed.length, 0);
  assert.equal(blocked[0]?.sent, true);
});

test('a permitted guest is still refused from an owner tool', async () => {
  let ran = false;
  const agent = new Agent(
    cfg({ senders: [PERMITTED] }),
    {
      label: 'test',
      chat: async () => ({
        text: '',
        toolCalls: [{ id: '1', name: 'hp_shell', arguments: { command: 'id' } }],
      }),
    },
    undefined,
    [{ ...hpShell, run: async () => { ran = true; return { ok: true, content: 'ran' }; } }],
  );
  const turn = await agent.handle(PERMITTED, 'run id');
  assert.equal(ran, false);
  assert.equal(turn.toolCalls[0]?.refused, true);
});
