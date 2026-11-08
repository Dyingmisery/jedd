import type { ChoiceStore } from '../choices.js';
import type { Config } from '../config.js';
import type { KindleRegistry } from '../kindle.js';
import type { FollowupStore } from '../followups.js';
import type { ExecImpl } from '../hp.js';
import type { Role } from '../permissions.js';

export interface ToolContext {
  role: Role;
  senderHandle: string;
  config: Config;
  /**
   * Test seam ONLY: the exec implementation `runOnHp` should use. Unset in
   * production, where `runOnHp` falls back to `execFile`.
   *
   * It exists so a test can assert on the exact command string a tool would have
   * sent over ssh — including asserting that a REFUSED argument produced no ssh
   * call at all. A refusal that still ran the command is the failure mode this
   * seam is here to detect, and it is not observable from the return value.
   */
  exec?: ExecImpl;
  /**
   * Test seam ONLY: how a tool waits. Unset in production, where it is a real
   * timer. Exists so a settle delay does not make the suite take a minute.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where a tool records work that is not finished when it returns.
   *
   * Optional so a tool that cannot schedule still WORKS — it just cannot promise
   * to come back. A tool must therefore never claim a follow-up it did not
   * manage to schedule.
   */
  followups?: FollowupStore;
  /**
   * Where numbered options live between turns.
   *
   * 🔴 THE TOOL THAT PRODUCES OPTIONS STORES THEM. The model is never asked to
   * "remember to record the list" — that is bookkeeping we would be relying on
   * it to perform, and the failure is silent. The options are a side effect of
   * the search that generated them, so the only thing the model does is choose.
   */
  choices?: ChoiceStore;
  /**
   * 🔴 ONLY what THIS sender actually typed, this conversation. Never the
   * assistant's prose, never another sender's history.
   *
   * It is a plain `string[]` rather than a filtered message list on purpose:
   * V1's grounding corpus took `Array<{role: string; text: string}>` and
   * filtered to `role === 'user'`, so adding a third role would have silently
   * admitted it. **The filtering happens once, at the Agent, and what reaches a
   * tool cannot contain anything else.**
   */
  userTurns?: string[];
  /** Verified delivery addresses, keyed by sender. Never model-supplied. */
  kindle?: KindleRegistry;
  /**
   * Send one JPEG to this person. Failures are reported as false and must not
   * change whether a request was accepted. Optional: tests omit it.
   */
  sendImage?: (filename: string, bytes: Buffer) => Promise<boolean>;
}

/**
 * Every tool returns this shape, and the loop appends it to history verbatim.
 *
 * `ok` is set by the tool from what actually happened — a non-zero exit code, an
 * HTTP error, a refused precondition. Nothing downstream re-derives it from
 * prose. This is the record that makes "did you do it" answerable by
 * construction.
 */
export interface ToolResult {
  ok: boolean;
  /** Rendered back to the model as the tool message content. */
  content: string;
  /**
   * When set, this exact text is what the person is sent, and the model does
   * not get another turn to rephrase it.
   */
  verbatimReply?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** Minimum role required to CALL this tool. Enforced by the loop, not the prompt. */
  minRole: Role;
  /**
   * True if this tool can change the state of the homelab.
   *
   * 🔴 REQUIRED, and deliberately not defaulted. Write-ness is a property of the
   * MEMBER, not of the list it happens to sit in — the registry used to infer it
   * from which array a tool was in, so the read-only kill switch covered owner
   * writes and would have silently missed the first guest one.
   *
   * Defaulting this to `false` would pick the permissive answer for an author
   * who forgot; `registerable()` refuses to register a tool that has not said.
   *
   * It is a different axis from `minRole`: that decides WHO may call the tool,
   * this decides whether the tool does anything at all when writes are off.
   * Neither satisfies the other.
   */
  writes: boolean;
  /**
   * True if this tool cannot do anything without an ssh path to the homelab.
   *
   * ── WHY THIS IS A FLAG ON THE TOOL, NOT A LIST IN THE REGISTRY ────────────
   *
   * Exactly the lesson `writes` already carries: a hand-maintained list of
   * "the ssh tools" fixes today's twelve and rebuilds the same trap one list
   * further along, because the NEXT ssh tool joins the array and nobody
   * remembers the list. Reachability is a property of the MEMBER.
   *
   * ── WHAT IT PREVENTS ─────────────────────────────────────────────────────
   *
   * Measured on a simulated stranger's deploy (Ollama + Sonarr, no ssh host at
   * all): **twelve tools that reach the homelab over ssh were still offered to
   * the model.** Nothing crashed. The bot booted, reported healthy, and every
   * one of those tools would have failed at the moment somebody relied on it —
   * which reads as a homelab outage rather than as "you did not configure this".
   * An ABSENT tool cannot be offered, argued for, or promised to a user.
   *
   * ⚠️ Unlike `writes` this is OPTIONAL and defaults to false, because "needs
   * no ssh" is the honest answer for most tools and demanding a declaration
   * from every author would be noise. The failure direction is safe: a new ssh
   * tool that forgets the flag is merely registered when it should not be —
   * the status quo — rather than silently disappearing from a working install.
   */
  needsHomelabSsh?: boolean;
  /**
   * External services this tool cannot function without AT ALL.
   *
   * ALL of them must be configured or the tool is not registered — so a tool
   * naming two services is absent unless both exist. Declare only what the tool
   * is USELESS without.
   *
   * ⚠️ DO NOT DECLARE A SERVICE A TOOL MERELY *USES*. `check_status` and
   * `catalogue_search` span Sonarr and Radarr and degrade PARTIALLY: with Sonarr
   * alone, "is The Bear downloaded" is still answerable and "is Dune
   * downloaded" honestly is not. Listing both would delete a working capability
   * in order to avoid a partial one — over-gating, which is the same harm as
   * under-gating pointed the other way. They declare nothing, deliberately.
   */
  needsServices?: ('sonarr' | 'radarr' | 'prowlarr' | 'jellyfin' | 'qbittorrent' | 'dispatcharr' | 'audiobookshelf')[];
  /**
   * Services of which AT LEAST ONE must exist — the any-of counterpart to
   * `needsServices`.
   *
   * 🔴 "PARTIAL" NEEDS SOMETHING TO BE PARTIAL *OF*. `check_status` spans Sonarr
   * and Radarr and degrades gracefully: with Sonarr alone it still answers
   * "is The Bear downloaded" and honestly cannot answer for a film. Declaring
   * BOTH under `needsServices` would delete it from a Sonarr-only install —
   * over-gating. Declaring nothing leaves it registered-and-broken on an install
   * with NO *arr at all, where there is no half left to answer — under-gating.
   *
   * Neither all-of nor nothing is right for these, which is why the any-of case
   * exists rather than being squeezed into the other field.
   */
  needsAnyService?: ('sonarr' | 'radarr' | 'prowlarr' | 'jellyfin' | 'qbittorrent' | 'dispatcharr' | 'audiobookshelf')[];
  /**
   * 🔴 WHICH KIND OF STORED OPTION THIS TOOL RESOLVES A `choice` INTO.
   *
   * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────
   *
   * `add_audiobook` shipped registered, booting, present in the live tool line
   * — and UNCALLABLE. Its own description says *"Start downloading an audiobook
   * that an audiobook search found. Pass the number they chose."* **Nothing
   * produced that number.** V2 shipped the consumer without the producer, and
   * `send_ebook` was in exactly the same state.
   *
   * Every invariant we had passed. `registerable()` quantifies over
   * DECLARATIONS — `writes` declared, present in `ALL_TOOLS`, reachable from
   * `buildTools` — and the coverage test proves every `make*` export is
   * registered. **None of that knows about TOOL-TO-TOOL DATA DEPENDENCIES.** A
   * tool whose required argument is another tool's output has one, and an
   * orphaned consumer was indistinguishable from a working capability at every
   * layer we asserted on. It is the more instructive sibling of `add_season`:
   * that one was honestly absent; this one passed every green check.
   *
   * ── WHY IT CANNOT BE FORGOTTEN ───────────────────────────────────────────
   *
   * The trigger is STRUCTURAL, not a declaration: a tool whose `parameters`
   * REQUIRE a `choice` is a consumer, read straight off its schema. Having
   * detected that, `registerable()` refuses to register it unless it says which
   * kind — the same discipline as `writes`, and for the same reason: defaulting
   * picks the convenient answer for an author who forgot.
   *
   * `'*'` means kind-agnostic and belongs only to `resolve_choice`, which is the
   * generic resolver and genuinely does not care.
   */
  consumesChoiceKind?: string;
  /**
   * Which kinds of option this tool STORES via `ctx.choices.present`.
   *
   * The other half of the pair above: a consumed kind that nothing registered
   * produces is a capability that cannot be reached, and `registerable()`
   * throws rather than booting it.
   *
   * ⚠️ Forgetting this on a new PRODUCER causes a false alarm at startup, not a
   * silent gap. That is the fail-closed direction and it is the intended
   * asymmetry — the consumer side is the one that cannot be forgotten.
   */
  presentsChoiceKinds?: string[];
  /**
   * 🔴 WHAT THIS TOOL'S RESULT DOES **NOT** COVER, APPENDED TO EVERY RESULT IT
   * RETURNS — ok, fail and throw alike.
   *
   * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────
   *
   * Measured 2026-08-28, live, n=10: asked *"has tom watched anything yet"* the
   * model reached `jellyfin_sessions`, got a **true but narrow** answer — two
   * idle sessions — and converted the scope of that one result into a claim
   * about the whole system: *"I can only see live sessions … that's not
   * something I can pull."* **80% of reps denied a capability the same registry
   * demonstrably holds** (`homelab_read` had answered the same question two days
   * earlier). The tool did not fail. It answered a narrower question than the
   * one asked, and nothing in its answer said so.
   *
   * ── WHY A RESULT AND NOT A DESCRIPTION, WHICH IS THE WHOLE IDEA ──────────
   *
   * Rewriting the tool's DESCRIPTION was measured on this defect at **p = 0.31,
   * not convicted** (18 live turns, 3 variants). A description is read *before*
   * selection, when the model is choosing among 37 tools and has no idea which
   * one it is about to over-read. A RESULT is read *after* — at the exact moment
   * the model holds a narrow answer and is about to generalise it. Same words,
   * different moment, and the moment is the intervention.
   *
   * ⚠️ **So do not "improve" this by folding it into `description`.** That is a
   * different experiment and it has already been run and did not convict.
   *
   * ── WHAT BELONGS IN ONE ──────────────────────────────────────────────────
   *
   * Three things, and the second is the load-bearing one:
   *  1. what this result IS (the narrow scope, stated as a scope);
   *  2. that its silence is NOT evidence of absence — the wrong inference,
   *     named and refused, because that inference is the actual defect;
   *  3. WHERE the excluded thing lives, **by tool name**.
   *
   * 🔴 A name here is checked TWICE, because one check was not enough.
   * `assertNamedProducersExist` scans this field as well as `description` and
   * catches a RENAME OR DELETION IN CODE; it runs before `registerable()`'s
   * config filters and cannot see config-driven absence. A second loop at the
   * end of `registerable()` re-checks scope notes against the tools ACTUALLY
   * REGISTERED on this deployment. Either way, a note pointing at a tool that is
   * not there refuses to boot rather than telling the model to call something
   * that does not exist — which would be this very defect, pointing the other
   * way.
   *
   * ⚠️ **RULE FOR AUTHORS: name only tools registered unconditionally, or gated
   * exactly as this one is.** The check cannot tell "call `X`" from "`X` cannot
   * see this either", so a note that merely MENTIONS a conditionally-registered
   * tool refuses to boot on a deploy lacking it — a false boot failure on a
   * correct note. Lowercase, too: both scans are case-sensitive.
   *
   * ⚠️ Appended to every result that enters the MODEL'S HISTORY. That is the one
   * site in `agent.ts`, and it is NOT the same as "every call to `run()`" —
   * `followup-runner.ts` calls a tool directly and renders its content into
   * user-facing prose without going near it.
   *
   * ⚠️ Not the same thing as the local `scopeNote` inside
   * `src/tools/sports-fixture.ts`, which is a per-window string built by hand
   * inside `run()` and predates this field.
   *
   * ⚠️ Optional, and deliberately not defaulted-to-required. Most tools answer
   * the question they were picked for and a note would be noise; a tool without
   * one behaves exactly as before. The failure direction is safe.
   */
  scopeNote?: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string): ToolResult {
  return { ok: true, content };
}

export function fail(content: string): ToolResult {
  return { ok: false, content };
}
