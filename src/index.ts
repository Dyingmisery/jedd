import { appendFileSync, mkdirSync } from 'node:fs';
import { Agent, type TurnRecord } from './agent.js';
import { assertShellIdentityIsSafe, loadConfig } from './config.js';
import { proveShellIdentityIsSafe } from './identity-probe.js';
import { StdoutConnector, withPresence } from './connector.js';
import { FollowupStore } from './followups.js';
import { runDueFollowups } from './followup-runner.js';
import { imapMailboxReader, imapSettingsFrom } from './kindle-mailbox.js';
import { createLlmClient } from './llm.js';
import { ChoiceStore } from './choices.js';
import { KindleRegistry } from './kindle.js';
import { HistoryStore } from './store.js';
import { buildTools } from './tools/index.js';

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

function recordTurn(record: TurnRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(`${DATA_DIR}audit.jsonl`, `${JSON.stringify(record)}\n`, 'utf8');
  const summary = record.toolCalls.length
    ? record.toolCalls.map((c) => `${c.name}${c.refused ? '(REFUSED)' : c.ok ? '' : '(failed)'}`).join(', ')
    : 'no tools';
  console.error(`  [audit] ${record.role} · ${summary} · ${record.steps} step(s)`);
}

/** How often to look for follow-ups that have come due. */
const TICK_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLlmClient(config);

  // The cheap string check first — it catches an obvious misconfiguration
  // without a network round trip. It is NOT the boundary and never was.
  const preflight = assertShellIdentityIsSafe(config);
  // Then the one that actually runs something.
  const shellIdentity = preflight.safe
    ? await proveShellIdentityIsSafe(config)
    : { safe: false, reason: preflight.reason, evidence: ['pre-flight refused; probe not attempted'] };

  const tools = buildTools(config, shellIdentity);
  const history = new HistoryStore(`${DATA_DIR}history.jsonl`);
  const followups = new FollowupStore(`${DATA_DIR}followups.jsonl`);
  const imapSettings = imapSettingsFrom(config);
  const mailbox = 'missing' in imapSettings ? undefined : imapMailboxReader(imapSettings);
  const choices = new ChoiceStore(`${DATA_DIR}choices.jsonl`);
  const agent = new Agent(config, llm, recordTurn, tools, history, followups, choices, new KindleRegistry(`${DATA_DIR}kindle.jsonl`));
  const connector = new StdoutConnector(process.argv[2] ?? config.ownerHandle);

  console.error(
    `model=${llm.label} owner=${config.ownerHandle} ` +
      `shell-ssh=${config.shellSshHost} admin-ssh=${config.adminSshHost} ` +
      `writes=${config.readOnly ? 'DISABLED' : 'ENABLED'}`,
  );
  console.error(`tools=${tools.map((t) => t.name).join(', ')}`);
  console.error(`hp_shell: ${shellIdentity.safe ? 'enabled' : 'DISABLED'} — ${shellIdentity.reason}`);
  for (const line of shellIdentity.evidence) console.error(`  [identity] ${line}`);

  // The thing that wakes up. A follow-up whose work is not done when the turn
  // ends is not finished until the user has been told the outcome, and this is
  // the only path by which Jedd speaks without being spoken to.
  const pending = followups.due(new Date()).length;
  console.error(
    `followups: ${followups.all().filter((f) => f.status === 'pending').length} pending` +
      `${pending ? ` (${pending} already due)` : ''}, checked every ${TICK_MS / 1000}s`,
  );
  const report = (outcomes: Awaited<ReturnType<typeof runDueFollowups>>) => {
    for (const o of outcomes) {
      console.error(`  [followup] ${o.id} ${o.action}${o.sent ? ' (sent)' : ''} — ${o.detail}`);
    }
  };
  const followupDeps = {
    config,
    send: (to: string, text: string) => connector.send(to, text),
    /**
     * 🔴 THE SAME LOG FILE AS THE DAEMON, SO THIS TICK MUST NOT BE BLIND.
     *
     * This entry point ticks `data/followups.jsonl` — the daemon's store. A
     * `kindle-verify` record the daemon scheduled can come due here. Without a
     * reader this run would defer it (and eventually give up on it) for a
     * reason that is purely about which process happened to pick it up.
     */
    ...(mailbox ? { mailbox } : {}),
  };
  const timer = setInterval(() => {
    void runDueFollowups(followups, followupDeps).then(report);
  }, TICK_MS);
  timer.unref();
  const ebookTimer = setInterval(() => {
    void runDueFollowups(followups, followupDeps, { kind: 'ebook-deliver' }).then(report);
  }, config.ebookRecheckMs);
  ebookTimer.unref();

  // ⚠️ The same presence calls the live path makes, so the terminal exercises
  // the whole shape rather than a shorter one. On `StdoutConnector` they are a
  // no-op and a `(thinking…)` line — but a seam only stays honest if every entry
  // point goes through it, and a `withTyping` nothing ever calls is dead code
  // that will be wrong by the time somebody needs it.
  await connector.listen(async (message) => {
    await withPresence(connector, message, async () => {
      const record = await agent.handle(message.senderHandle, message.text);
      await connector.send(message.senderHandle, record.replyText || '(no reply)');
    });
  });
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
