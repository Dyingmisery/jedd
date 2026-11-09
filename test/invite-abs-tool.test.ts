import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AbsClient, type FetchImpl } from '../src/audiobookshelf.js';
import { InviteLedger } from '../src/invite-ledger.js';
import { buildTools } from '../src/tools/index.js';
import { makeAbsInviteTool, type AbsInviteDeps } from '../src/tools/invite-abs.js';
import type { InviteSender } from '../src/tools/invite.js';
import { testConfig } from './helpers.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'jedd-abs-')), 'l.jsonl');
const GUEST = '+13855550168';
const TARGET = '+15551234567';
const USER = 'kaelaabs';

function absClient(opts: { deleteOk?: boolean; createInactive?: boolean; createFails?: boolean } = {}) {
  const deleted: string[] = [];
  const createdBodies: unknown[] = [];
  let id = 'user-1';
  const impl: FetchImpl = async (url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, b: unknown) =>
      ({
        ok: status < 400,
        status,
        text: async () => JSON.stringify(b),
      }) as unknown as Response;

    if (method === 'POST' && u.endsWith('/api/users')) {
      createdBodies.push(body);
      if (opts.createFails) return reply(400, { error: 'bad' });
      assert.equal(body.isActive, true, 'isActive must be true');
      assert.equal(body.permissions?.accessAllLibraries, true);
      return reply(200, {
        user: {
          id,
          username: body.username,
          isActive: opts.createInactive ? false : true,
          type: 'user',
        },
      });
    }
    if (method === 'GET' && u.includes('/api/users/')) {
      return reply(200, {
        id,
        username: USER,
        isActive: opts.createInactive ? false : true,
        type: 'user',
      });
    }
    if (method === 'DELETE' && u.includes('/api/users/')) {
      deleted.push(u);
      return reply(opts.deleteOk === false ? 500 : 200, {});
    }
    return reply(404, { error: 'unexpected ' + method + ' ' + u });
  };
  const client = new AbsClient({
    baseUrl: 'http://abs.invalid:13378',
    apiKey: 'k',
    publicUrl: 'http://abs.invalid:13378',
    fetchImpl: impl,
  });
  return { client, deleted, createdBodies };
}

const sender = (delivered: boolean | null): { send: InviteSender; sent: { to: string; text: string }[] } => {
  const sent: { to: string; text: string }[] = [];
  return {
    sent,
    send: async (to, text) => {
      sent.push({ to, text });
      return { delivered, detail: 'x' };
    },
  };
};

function ctx(turns = [`please make ${USER} for ${TARGET}`]) {
  return {
    role: 'guest' as const,
    senderHandle: GUEST,
    config: testConfig({ readOnly: false }),
    userTurns: turns,
  };
}

test('🔴 failed delivery DELETES the ABS user — password must not survive', async () => {
  const a = absClient();
  const s = sender(false);
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ username: USER, recipient: TARGET }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /DELETED/);
  assert.equal(a.deleted.length, 1);
  assert.doesNotMatch(r.content, /Password:/);
  assert.equal(s.sent.length, 1);
});

test('🔴 delivery failed AND delete failed reports a LIVE credential', async () => {
  const a = absClient({ deleteOk: false });
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: sender(false).send });
  const r = await tool.run({ username: USER, recipient: TARGET }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.content, /DELETE FAILED/);
});

test('successful send includes login URL and does not leave delete calls', async () => {
  const a = absClient();
  const s = sender(true);
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ username: USER, recipient: TARGET }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /SENT/);
  assert.equal(a.deleted.length, 0);
  assert.match(s.sent[0]!.text, /Username: kaelaabs/);
  assert.match(s.sent[0]!.text, /Password: /);
  assert.match(s.sent[0]!.text, /http:\/\/abs\.invalid:13378/);
  assert.equal((a.createdBodies[0] as { isActive: boolean }).isActive, true);
});

test('REFUSED when username was not typed by the sender', async () => {
  const a = absClient();
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: sender(true).send });
  const r = await tool.run({ username: USER, recipient: TARGET }, ctx([`only ${TARGET} please`]));
  assert.equal(r.ok, false);
  assert.match(r.content, /REFUSED/);
  assert.equal(a.createdBodies.length, 0);
});

test('create always sends isActive true (control)', async () => {
  const a = absClient();
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: sender(true).send });
  await tool.run({ username: USER, recipient: TARGET }, ctx());
  assert.equal((a.createdBodies[0] as { isActive: boolean }).isActive, true);
});

test('tool is absent when ABS is not configured', () => {
  const cfg = testConfig({
    readOnly: false,
    audiobookshelf: { baseUrl: '', apiKey: '', publicUrl: '' },
    services: {
      sonarr: true,
      radarr: true,
      prowlarr: true,
      jellyfin: true,
      plex: false,
      qbittorrent: true,
      dispatcharr: true,
      audiobookshelf: false,
    },
  });
  const tools = buildTools(cfg, undefined, {
    absInvite: {
      abs: new AbsClient({ baseUrl: 'http://x', apiKey: 'k', publicUrl: 'http://x' }),
      ledger: new InviteLedger(tmp()),
      send: async () => ({ delivered: true, detail: 'x' }),
    },
  });
  assert.equal(
    tools.some((t) => t.name === 'invite_to_audiobookshelf'),
    false,
  );
});

test('tool is registered when ABS is configured', () => {
  const cfg = testConfig({ readOnly: false });
  const deps: AbsInviteDeps = {
    abs: new AbsClient({
      baseUrl: cfg.audiobookshelf.baseUrl,
      apiKey: cfg.audiobookshelf.apiKey,
      publicUrl: cfg.audiobookshelf.publicUrl,
    }),
    ledger: new InviteLedger(tmp()),
    send: async () => ({ delivered: true, detail: 'x' }),
  };
  const tools = buildTools(cfg, undefined, { absInvite: deps });
  assert.equal(tools.some((t) => t.name === 'invite_to_audiobookshelf'), true);
});

// ── optional password ─────────────────────────────────────────────────────────

test('optional password omitted → generated password is sent', async () => {
  const a = absClient();
  const s = sender(true);
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run({ username: USER, recipient: TARGET }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /Password was generated/);
  assert.doesNotMatch(r.content, /Password: /); // tool result must not echo it
  const body = a.createdBodies[0] as { password: string };
  assert.ok(body.password.length >= 12);
  assert.match(s.sent[0]!.text, new RegExp(`Password: ${body.password}`));
});

test('optional password provided + in turns → used as-is', async () => {
  const a = absClient();
  const s = sender(true);
  const pw = 'CorrectHorse9';
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: s.send });
  const r = await tool.run(
    { username: USER, recipient: TARGET, password: pw },
    ctx([`please make ${USER} for ${TARGET} password ${pw}`]),
  );
  assert.equal(r.ok, true, r.content);
  assert.match(r.content, /Password was set from what they typed/);
  assert.doesNotMatch(r.content, /CorrectHorse9/);
  assert.equal((a.createdBodies[0] as { password: string }).password, pw);
  assert.match(s.sent[0]!.text, /Password: CorrectHorse9/);
});

test('optional password provided + NOT in turns → REFUSED', async () => {
  const a = absClient();
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: sender(true).send });
  const r = await tool.run(
    { username: USER, recipient: TARGET, password: 'CorrectHorse9' },
    ctx([`please make ${USER} for ${TARGET}`]),
  );
  assert.equal(r.ok, false);
  assert.match(r.content, /REFUSED/);
  assert.match(r.content, /does not appear in anything this person typed/i);
  assert.equal(a.createdBodies.length, 0);
  assert.doesNotMatch(r.content, /CorrectHorse9/);
});

test('optional password weak → REFUSED', async () => {
  const a = absClient();
  const tool = makeAbsInviteTool({ abs: a.client, ledger: new InviteLedger(tmp()), send: sender(true).send });
  for (const pw of ['short1A', 'password1', 'abcdefgh', '12345678']) {
    const r = await tool.run(
      { username: USER, recipient: TARGET, password: pw },
      ctx([`please make ${USER} for ${TARGET} ${pw}`]),
    );
    assert.equal(r.ok, false, `should refuse ${pw}`);
    assert.match(r.content, /REFUSED/);
    assert.doesNotMatch(r.content, new RegExp(pw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(a.createdBodies.length, 0);
});
