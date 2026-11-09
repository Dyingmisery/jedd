import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { ALL_TOOLS, buildTools } from '../src/tools/index.js';
import type { Tool } from '../src/tools/types.js';
import { testConfig } from './helpers.js';

/**
 * 🔴 EVERY TOOL THAT EXISTS IS IN THE REGISTRY. QUANTIFIED OVER THE DIRECTORY.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `invite_to_jellyfin` was written, unit-tested, mutation-swept at 6/6 — and
 * then **never added to `buildTools`**, so it did not exist at runtime. Nothing
 * failed. 478 tests stayed green, because every one of them constructed the tool
 * directly. **A test that imports the tool it is testing cannot notice that
 * nobody else imports it.**
 *
 * `send_ebook` had the same hole at the same moment, and it is the one that
 * shows the shape of the trap: it had been **verified live end to end — a real
 * book reached a real Kindle** — through a script that built it directly. So
 * "it works" and "it is reachable" were both true of different objects.
 *
 * Both are factories that take deps, which is exactly the property that caused
 * it: every other tool is a module-level const and gets registered by appending
 * to an array in one file. A tool with deps needs a second file edited, and the
 * second edit is the one that gets forgotten.
 *
 * ── WHY IT READS THE DIRECTORY ───────────────────────────────────────────────
 *
 * A hand-listed set of expected tools is the same class of object as the
 * registry it checks: something a person maintains and can forget. This walks
 * `src/tools/`, so a NEW tool file is covered the moment it exists — including
 * one nobody thought to add here.
 */

const TOOL_DIR = new URL('../src/tools/', import.meta.url);

/** Does this value quack like a Tool? */
function isTool(v: unknown): v is Tool {
  const t = v as Partial<Tool> | null;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.name === 'string' &&
    typeof t.run === 'function' &&
    typeof t.minRole === 'string'
  );
}

/**
 * Every tool this repo can build, found by construction rather than by memory.
 *
 * ⚠️ A factory that THROWS while being constructed is reported, never skipped. A
 * silent skip is how this guard would die: the tool it could not build is
 * exactly the tool most likely to be missing from the registry.
 */
async function declaredTools(): Promise<{ tools: Tool[]; unbuildable: string[] }> {
  const tools: Tool[] = [];
  const unbuildable: string[] = [];
  const files = readdirSync(TOOL_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts');
  for (const file of files) {
    const mod = (await import(new URL(file, TOOL_DIR).pathname)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (isTool(value)) {
        tools.push(value);
        continue;
      }
      if (typeof value !== 'function' || !/^make[A-Z]/.test(name)) continue;
      try {
        // Deps are used inside `run`, not at construction, so an empty object is
        // enough to obtain the tool's identity without doing anything.
        const built = (value as (d: unknown) => unknown)({});
        if (isTool(built)) tools.push(built);
      } catch (e) {
        unbuildable.push(`${file}:${name} — ${(e as Error).message}`);
      }
    }
  }
  return { tools, unbuildable };
}

test('🔴 every tool defined in src/tools is present in ALL_TOOLS', async () => {
  const { tools, unbuildable } = await declaredTools();
  assert.deepEqual(unbuildable, [], 'a factory that cannot be constructed is not covered by this guard');
  const registered = new Set(ALL_TOOLS.map((t) => t.name));
  const missing = [...new Set(tools.map((t) => t.name))].filter((n) => !registered.has(n));
  assert.deepEqual(
    missing,
    [],
    `defined but absent from ALL_TOOLS: ${missing.join(', ')} — a tool nobody registered does not exist`,
  );
});

test('🔴 every tool in ALL_TOOLS is reachable from buildTools under SOME configuration', async () => {
  // ALL_TOOLS is a documentation surface; `buildTools` is what production runs.
  // A tool present in the first and absent from the second is unreachable, which
  // is the exact state invite_to_jellyfin and send_ebook were in.
  const config = testConfig({
    readOnly: false,
    runbookPath: '/tmp/jedd-runbook.md',
    services: { ...testConfig().services, plex: true },
  });
  const built = new Set(
    buildTools(config, { safe: true, reason: 'test', evidence: [] }, {
      invite: {
        jfago: {} as never,
        ledger: {} as never,
        send: async () => ({ delivered: null, detail: '' }),
      },
      absInvite: {
        abs: {} as never,
        ledger: {} as never,
        send: async () => ({ delivered: null, detail: '' }),
      },
      ebook: { send: async () => ({ messageId: 'x' }) },
    }).map((t) => t.name),
  );
  const unreachable = ALL_TOOLS.map((t) => t.name).filter((n) => !built.has(n));
  assert.deepEqual(unreachable, [], `in ALL_TOOLS but unreachable from buildTools: ${unreachable.join(', ')}`);
});

test('CONTROL: the enumeration actually found the tools, so neither check is vacuous', async () => {
  const { tools } = await declaredTools();
  assert.ok(tools.length >= 15, `only found ${tools.length} tools by walking src/tools`);
  assert.ok(ALL_TOOLS.length >= 15);
});
