import { type Config } from '../config.js';
import type { IrcEbooks } from '../media/irc-ebooks.js';
import type { IdentityVerdict } from '../identity-probe.js';
import { InviteLedger } from '../invite-ledger.js';
import { JfagoClient } from '../jfago.js';
import { roleSatisfies, type Role } from '../permissions.js';
import { containerNetns, dockerInspect, dockerLogs, dockerPs } from './docker.js';
import {
  hpShell,
  jellyfinSessions,
  livetvStatus,
  restartArrStack,
  restartContainer,
} from './homelab.js';
import { addAudiobook } from './add-audiobook.js';
import { makeAddMovie, makeAddSeries } from './add-media.js';
import { channelHealth } from './channel-health.js';
import { makeHomelabRead } from './homelab-read.js';
import { makeAddSeason } from './add-season.js';
import { makeCatalogueSearch } from './catalogue.js';
import { makeCheckStatus } from './check-status.js';
import { resolveChoice } from './choice.js';
import { kindleStatus, saveKindleEmail } from './kindle.js';
import { librarySearch } from './library.js';
import { makePlexAvailability } from './plex-availability.js';
import { makeFindGaps, makeGrabRelease, makeSearchEpisode } from './fill-gaps.js';
import { makeIndexerAdmin } from './indexer-admin.js';
import { makeInviteTool, type InviteDeps } from './invite.js';
import { makeAbsInviteTool, type AbsInviteDeps } from './invite-abs.js';
import { AbsClient } from '../audiobookshelf.js';
import { diagnoseHostContention, restoreQbitSpeed, shedHostLoad } from './qbit.js';
import { makeRunbookTool } from './runbook.js';
import { makeSearchAudiobook, makeSearchEbook } from './search-release.js';
import { makeSendEbook, type SendEbookDeps } from './send-ebook.js';
import { makeSportsFixture } from './sports-fixture.js';
import { makeStuckDownloads } from './stuck-downloads.js';
import { makeTitleDetails } from './title-details.js';
import { makeTrending } from './trending.js';
import type { Tool } from './types.js';

/**
 * Which ssh identity a tool uses is decided by WHO COMPOSES THE COMMAND TEXT.
 *
 *   model-composed text  → `config.shellSshHost`  (unprivileged, no docker)
 *   code-composed text   → `config.adminSshHost`  (privileged, has docker)
 *
 * `livetv_status` and `restart_container` run privileged, and that is safe
 * because their command strings are literals in this repo with only validated,
 * non-string parameters interpolated. `hp_shell` is the only tool where the
 * model writes the command, and it is the only one that must be unprivileged.
 *
 * If you add a tool that interpolates model-supplied STRINGS into a shell
 * command, it belongs on the shell identity, not the admin one.
 *
 * The docker tools (`docker_ps`, `docker_inspect`, `docker_logs`,
 * `container_netns`) are the reason the identity split costs no capability. The
 * shell account has no docker access at all, and none is missing: those reads
 * were never shell-shaped. Their command strings are literals here with one
 * hole, a container name, validated by `isValidContainerName` before it is
 * interpolated. 🔴 That validation is the entire defence on the privileged
 * identity — see `src/tools/docker.ts`.
 */

const GUEST_TOOLS: Tool[] = [
  librarySearch,
  makePlexAvailability(),
  /**
   * 🔴 THE GENERIC READ IS GUEST-LEVEL, AND THE GATE IS THE DATA, NOT THE ROLE.
   *
   * Jeff overruled an earlier owner-only reading: *"All users should have read
   * access to everything in the library, etc, but not other users information or
   * server secrets."* So the boundary moved from *who is asking* to *what the
   * data is about* — CONTENT for everyone, PERSON for the owner, SECRET for
   * nobody. All three live in `src/homelab-read.ts`.
   *
   * ⚠️ THE CONSEQUENCE FOR WHOEVER EDITS THAT DENYLIST NEXT: it is no longer
   * backstopped by a role gate. While this tool was owner-only, a path someone
   * forgot to classify was contained to Jeff. Now a missed PERSON path is
   * visible to every guest in the house. Deny the borderline case; un-denying is
   * one line and a leak is not.
   *
   * ⚠️ This is what let `homelab_status` retire — a guest can now ask whether
   * the server is up. It was safe to remove ONLY because nothing NAMED it;
   * `assertNamedProducersExist` would have thrown for `catalogue_search` or any
   * of the four docker tools. Absence of a guard is not permission.
   */
  makeHomelabRead(),
  makeCatalogueSearch(),
  makeCheckStatus(),
  resolveChoice,
  // 🔴 The PRODUCERS for add_audiobook and send_ebook, which shipped without
  // them and were uncallable. Reads: they search and store a list; nothing is
  // grabbed until the consumer runs. See search-release.ts.
  makeSearchAudiobook(),
  // Filling gaps in a series. Both READS: they list what is missing and what
  // releases exist. Only grab_release writes. See fill-gaps.ts for why none of
  // this touches a quality profile.
  makeFindGaps(),
  makeSearchEpisode(),
  /**
   * 🔴 GUEST BECAUSE IT IS CONTENT, NOT BECAUSE IT IS HARMLESS.
   *
   * Jeff's rule is about WHAT THE DATA IS ABOUT, not who is asking: *"All users
   * should have read access to everything in the library, etc, but not other
   * users information or server secrets."* What is on television is not about a
   * person, so it sits with `library_search` on the guest side. It reads a
   * public sports schedule and the shared TV guide, and names nobody.
   */
  makeSportsFixture(),
];

/**
 * 🔴 GUEST WRITES. Jeff, 2026-08-24: "yes guests can request real media and add users."
 *
 * These are `writes: true` at `minRole: 'guest'` — the combination that did not
 * exist when `buildTools` inferred write-ness from which array a tool sat in,
 * and the reason `registerable()` now quantifies the kill switch over the whole
 * registry instead. This is the first real member of that combination.
 */
const GUEST_WRITE_TOOLS: Tool[] = [
  makeAddMovie(),
  makeAddSeries(),
  // 🔴 `add_season` is the verb V1 had and V2 shipped without: `add_series`
  // scopes seasons at CREATE time only, so a show Sonarr already holds had no
  // path at all. Jeff hit it on his first real test, asking for Seinfeld S3.
  makeAddSeason(),
  makeGrabRelease(),
  addAudiobook,
];

/**
 * 🔴 THE INVITE TOOL IS BUILT FROM INJECTED DEPS, WHICH IS WHY IT WAS MISSING.
 *
 * `invite_to_jellyfin` was written, tested and mutation-swept — and then not
 * registered, because it is the only tool that cannot be a module-level const:
 * it needs a jfa-go client, a persistent ledger and **a way to send a text**,
 * and the send path belongs to the connector, not to a tool file. Every other
 * tool could be added by appending to an array in this file; this one needed a
 * parameter, so adding it was a two-file change and the second file was never
 * edited. **It was absent by omission, in a registry whose whole design is that
 * absence should be by construction.**
 *
 * That is the reason `buildTools` now takes deps rather than the invite tool
 * reaching for a module-level singleton: the thing that decides whether a
 * credential can be minted is now visible in the call that builds the registry.
 */
export interface ToolDeps {
  /** Absent → `invite_to_jellyfin` is not registered at all. */
  invite?: InviteDeps;
  /** Absent → `invite_to_audiobookshelf` is not registered at all. */
  absInvite?: AbsInviteDeps;
  /**
   * Absent → `send_ebook` is not registered at all.
   *
   * 🔴 `send_ebook` had the SAME omission as the invite tool and it is the one
   * that shows the shape of the trap: it was **verified live end to end, a real
   * book reached a real Kindle**, through a script that constructed it directly.
   * "It works" and "it is reachable" were both true, of different objects.
   */
  ebook?: SendEbookDeps;
  /**
   * The IRC #ebooks source, when this deployment has one.
   *
   * 🔴 UNLIKE `invite` AND `ebook`, THIS IS **NOT** A REGISTRATION GATE.
   *
   * Those gate registration because without them the tool would offer a
   * capability that cannot complete — an invite with no jfa-go, a send with no
   * SMTP. IRC is different in kind: it is a SECOND SOURCE for a tool that works
   * perfectly well with one. Gating on it would take `search_ebook` down
   * whenever IRC was unreachable, which is the opposite of what a second source
   * is for. Absent, or sick, it degrades to Prowlarr-only and says so.
   */
  irc?: IrcEbooks;
}

/**
 * ⚠️ An INERT invite tool, for enumeration only — `ALL_TOOLS`, and nothing else.
 *
 * It is pointed at `jfa-go.invalid` (RFC 2606, can never resolve) with a sender
 * that throws, so the worst a mistaken use can do is fail to mint. The
 * enumeration invariants — every tool declares `writes`, every tool is gated by
 * role, no tool takes an unvouched delivery address — must see this tool, and
 * they can only see what is in a list.
 *
 * ⚠️ `ALL_TOOLS` already carries `hpShell` regardless of the identity proof, so
 * it is a documentation surface rather than a runnable registry. Do not start
 * treating it as one.
 */
const INERT_SEND_EBOOK: SendEbookDeps = {
  send: async () => {
    throw new Error('ALL_TOOLS carries an INERT send_ebook; it cannot mail. Use buildTools(deps).');
  },
  onlySendTo: 'nobody@invalid',
};


const INERT_ABS_INVITE: AbsInviteDeps = {
  abs: new AbsClient({
    baseUrl: 'http://abs.invalid:13378',
    apiKey: '',
    publicUrl: 'http://abs.invalid:13378',
  }),
  ledger: new InviteLedger('/nonexistent/jedd-inert-abs-invites.jsonl'),
  send: async () => {
    throw new Error('ALL_TOOLS carries an INERT invite_to_audiobookshelf; it cannot send. Use buildTools(deps).');
  },
};

const INERT_INVITE: InviteDeps = {
  jfago: new JfagoClient({
    baseUrl: 'http://jfa-go.invalid:8056',
    inviteBaseUrl: 'http://jfa-go.invalid',
    username: '',
    password: '',
    profile: 'Default',
    validityHours: 24,
  }),
  ledger: new InviteLedger('/nonexistent/jedd-inert-invites.jsonl'),
  send: async () => {
    throw new Error('ALL_TOOLS carries an INERT invite tool; it cannot send. Use buildTools(deps).');
  },
};
const OWNER_READ_TOOLS: Tool[] = [
  jellyfinSessions,
  livetvStatus,
  diagnoseHostContention,
  dockerPs,
  dockerInspect,
  dockerLogs,
  containerNetns,
  /**
   * Not replaceable by the generic read at any path: the results are a FILE on
   * hp and the roster is Dispatcharr's Postgres behind `docker exec`. Neither is
   * HTTP-reachable.
   */
  channelHealth,
];
/**
 * ⚠️ `shed_host_load` is a WRITE and lives here, so it does not exist at all
 * unless writes are enabled — even though it is the SAFEST action in the set and
 * the only one that can be applied while someone is watching. Safe-to-run and
 * allowed-to-run are different axes, and this file only decides the second.
 */
const OWNER_WRITE_TOOLS: Tool[] = [
  restartContainer,
  restartArrStack,
  shedHostLoad,
  restoreQbitSpeed,
  /**
   * 🔴 THE FIRST WRITE PATH TO AN INDEXER, AND IT IS ITS OWN PRODUCER.
   *
   * Jeff, 2026-08-26: *"Can you fix the torrent indexers in prowler?"* — Jedd
   * had no way to, and was right to say so. `homelab_read` could see indexer
   * health and, being a GET by construction, could never change it.
   *
   * ⚠️ It carries `action: "list"` for a reason that belongs in THIS file:
   * `test` / `enable` / `disable` all need an indexer id, and nothing else
   * registered here can supply one for a HEALTHY indexer. Prowlarr's
   * `/api/v1/indexerstatus` — the only indexer path `homelab_read` may read —
   * lists ONLY the ones currently failing and is `[]` the rest of the time, and
   * `/api/v1/indexer` is denied to it as SECRET. So without its own list action
   * this would be an orphaned consumer that happened to work while something was
   * broken: `add_audiobook`'s defect wearing a disguise good enough to pass a
   * live test.
   *
   * ⚠️ Owner-only rather than guest, unlike `add_movie`: nothing here gets a
   * guest content, and disabling an indexer degrades searching for the house.
   */
  makeIndexerAdmin(),
  /**
   * 🔴 THE VERB JEDD HONESTLY DID NOT HAVE.
   *
   * Jeff, 2026-08-26: *"Can you just try to get the downloads cleared"* → *"I
   * can't clear them — I have no tool to delete or remove releases from
   * qBittorrent or the arrs."* Unlike the Prowlarr denial twenty minutes
   * earlier, **that one was true**, and the `stalled-download-fix` job has been
   * doing this work on a schedule the whole time — the procedure was specified
   * and battle-tested; only Jedd's access was missing.
   *
   * ⚠️ Owner-only and `writes: true` while it still only READS, because the
   * destructive actions land in this same tool rather than a second one. See
   * the file for why the guards are verdict-gated in code instead of a
   * confirmation prompt.
   */
  makeStuckDownloads(),
];

/**
 * Build the tool registry for this process.
 *
 * Two things are decided here rather than at call time, because a tool that is
 * never registered cannot be argued for:
 *  - `hp_shell` is omitted entirely when the ssh identity split is missing.
 *  - write tools are omitted entirely when running read-only.
 *
 * 🔴 `shellIdentity` is the verdict from `proveShellIdentityIsSafe()`, which
 * RUNS `id` and a docker crossing against both hosts. **Omitting it means
 * `hp_shell` is not registered at all** — a caller that forgets to prove the
 * boundary gets no free-form shell, rather than getting one on the strength of a
 * string comparison. Fail closed by construction, not by remembering to check.
 */
export function buildTools(config: Config, shellIdentity?: IdentityVerdict, deps: ToolDeps = {}): Tool[] {
  const tools = [...GUEST_TOOLS, ...GUEST_WRITE_TOOLS, ...OWNER_READ_TOOLS, ...OWNER_WRITE_TOOLS];
  if (shellIdentity?.safe) tools.push(hpShell);
  if (config.runbookPath) tools.push(makeRunbookTool(config.runbookPath));
  // Same rule as hp_shell and read_runbook: no jfa-go, no tool. A registered
  // invite tool that cannot reach jfa-go would offer a capability that fails
  // AFTER the model has promised it to someone.
  // ⚠️ BOTH fields, not just the password. A config with a password and no
  // base URL used to register a tool that could only ever fire requests at an
  // empty base — a gate that checks one of the two things it needs is not a
  // gate, it just narrows the ways of getting it wrong.
  if (deps.invite && config.jfago.password && config.jfago.baseUrl) {
    tools.push(makeInviteTool(deps.invite));
  }
  if (deps.absInvite && config.audiobookshelf.apiKey && config.audiobookshelf.baseUrl) {
    tools.push(makeAbsInviteTool(deps.absInvite));
  }
  // Same rule: no SMTP credential, no tool. A send_ebook that cannot mail would
  // tell somebody their book is on the way and then fail at the last step.
  /**
   * 🔴 THE EBOOK PAIR IS ATOMIC — both halves, or neither.
   *
   * `send_ebook` is conditional on an SMTP credential, so on a deploy without
   * one it does not exist. `search_ebook` sat in the unconditional list and its
   * description tells the model to *"call send_ebook with their number"* — so it
   * shipped a flow whose second step was absent: books found, none sendable.
   *
   * That is the same dead-end as the orphaned consumers, pointing the other way,
   * and `assertNamedProducersExist` caught it on its first run rather than a
   * user finding it. A producer whose only consumer is absent is not a
   * capability either.
   */
  if (deps.ebook && config.kindle.smtpPassword) {
    tools.push(
      makeSendEbook(deps.irc ? { ...deps.ebook, irc: deps.irc } : deps.ebook),
      makeSearchEbook(undefined, deps.irc),
      /**
       * 🔴 THE INTAKE HALF BELONGS TO THE SAME GATE — SECOND INSTANCE OF THE
       * ORPHAN BUG, AND THE QUIET ONE.
       *
       * `save_kindle_email` and `kindle_status` used to be registered
       * unconditionally, so a deployment with no SMTP offered a guest the chance
       * to hand over their Kindle address, told them it was SAVED, and had
       * nothing in the registry that could ever send them a book. Nothing
       * errored; the capability simply dead-ended.
       *
       * Collecting an address is not a feature on its own — it is the first step
       * of delivery. All four halves of the flow appear together or not at all.
       */
      saveKindleEmail,
      kindleStatus,
    );
  }
  // Same rule again: no TMDB token, no tool. A registered whats_popular with no
  // credential would answer every "what's good right now" with a failure, after
  // the model has already offered to look.
  if (config.tmdb.readToken) tools.push(makeTrending(), makeTitleDetails());
  return registerable(tools, config);
}

/**
 * 🔴 THE READ-ONLY KILL SWITCH, APPLIED OVER THE WHOLE REGISTRY.
 *
 * Every candidate tool passes through here, and the rule is quantified rather
 * than aimed at a named list: **for every tool, `writes` implies absent when
 * `readOnly`.**
 *
 * This replaces gating on the OWNER write array, which made the guest tool list
 * byte-identical with writes on and off. That was dormant only because no guest
 * write tool existed — and Jeff has now authorised guests to add media and
 * provision accounts, so the first one is imminent. A second hand-maintained
 * GUEST_WRITE_TOOLS array would have fixed this instance and rebuilt the same
 * trap one list further along: **write-ness is a property of the MEMBER, not of
 * the list it sits in.**
 *
 * An undeclared tool is REFUSED rather than defaulted, because defaulting picks
 * the permissive answer for an author who simply forgot.
 */
export function registerable(tools: Tool[], config: Config): Tool[] {
  for (const t of tools) {
    if (typeof t.writes !== 'boolean') {
      throw new Error(
        `Tool "${t.name}" does not declare writes. Every tool must declare whether it can change ` +
          'the homelab, so the read-only kill switch can cover it regardless of which role it is ' +
          'offered to. This is not defaulted on purpose.',
      );
    }
  }
  assertChoiceProducersExist(tools);
  assertNamedProducersExist(tools);
  // Two independent filters, applied together. `readOnly` is about whether the
  // tool may ACT; `needsHomelabSsh` is about whether it could act at all on this
  // deployment. Neither substitutes for the other: a READ tool over ssh survives
  // the read-only filter and still has nothing to talk to.
  const reachable = config.homelabSshConfigured ? tools : tools.filter((t) => !t.needsHomelabSsh);
  // A tool for a service nobody runs is not a feature. ALL declared services
  // must be present — a tool naming two is absent unless both are.
  const served = reachable
    .filter((t) => (t.needsServices ?? []).every((svc) => config.services[svc]))
    // any-of: an empty declaration means "no requirement", not "requires none".
    .filter((t) => {
      const any = t.needsAnyService ?? [];
      return any.length === 0 || any.some((svc) => config.services[svc]);
    });
  const registered = config.readOnly ? served.filter((t) => !t.writes) : served;
  /**
   * 🔴 AFTER THE FILTERS, NOT BEFORE — AND THAT ORDERING IS THE WHOLE VALUE.
   *
   * `assertNamedProducersExist` above runs on the PRE-FILTER array, so its
   * "present" set is "defined in this file", not "offered to the model". It
   * catches a tool RENAMED OR DELETED IN CODE and is blind to one removed BY
   * CONFIG — and the three filters that decide registration all run below it.
   *
   * ⚠️ A comment claiming a scope note "cannot point at an unregistered tool"
   * would therefore have been a defence covering ONE INSTANCE of a class while
   * reading as though it covered the class — the exact failure this branch
   * exists to fix, one field along. `jellyfin_sessions` needs Jellyfin and
   * `homelab_read` needs ANY ONE of five services, so the implication holds
   * today only because `jellyfin` happens to be in that list of five. Drop it
   * from there — plausible, since that tool's own comment says it "degrades
   * partially" — and a Jellyfin-only deploy boots green with a note pointing at
   * a tool that is not there.
   *
   * ⚠️ ONLY `scopeNote` IS CHECKED HERE, deliberately. Descriptions have named
   * conditionally-registered siblings for months, and a post-filter rule over
   * them would turn correct partial deploys into boot failures. Scope notes are
   * new, few, and governed by the rule on `Tool.scopeNote`: name only tools
   * registered unconditionally, or gated exactly as you are.
   */
  const registeredNames = new Set(registered.map((t) => t.name));
  const definedNames = new Set(ALL_TOOLS.map((t) => t.name));
  for (const t of registered) {
    if (!t.scopeNote) continue;
    for (const dep of t.scopeNote.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? []) {
      if (!definedNames.has(dep) || dep === t.name || registeredNames.has(dep)) continue;
      throw new Error(
        `Tool "${t.name}" has a scope note telling the model to use "${dep}", which is NOT ` +
          'registered on this deployment. A result that redirects the model to a tool it cannot ' +
          'see is the false-capability defect pointed the other way. Name only tools gated the ' +
          'same way this one is.',
      );
    }
  }
  return registered;
}

/**
 * Does this tool's own schema TAKE a `choice`?
 *
 * ⚠️ IT READS THE PROPERTY, NOT THE `required` LIST, AND THAT IS THE WHOLE
 * POINT. This used to check `required.includes('choice')`, which was true of
 * every consumer right up until the release pick became automatic and
 * `grab_release`, `add_audiobook` and `send_ebook` all moved `choice` out of
 * `required` so they could be called with no arguments. That left this rule
 * matching exactly ONE registered tool — `resolve_choice`, whose kind is `'*'`
 * and is exempt — so the schema axis of the invariant fired for nothing at all,
 * and those three consumers were covered only by their descriptions happening to
 * name their producers. A rule that quietly stops applying is worse than one
 * that was never written.
 *
 * A tool that accepts a choice depends on a list, whether or not it insists on
 * one.
 */
function requiresChoice(t: Tool): boolean {
  const props = (t.parameters as { properties?: Record<string, unknown> }).properties;
  return !!props && Object.prototype.hasOwnProperty.call(props, 'choice');
}

/**
 * 🔴 A CONSUMER WITHOUT A PRODUCER IS NOT A CAPABILITY.
 *
 * `add_audiobook` was registered, booted, appeared in the live tool line, and
 * could never be called: it resolves a pick from an audiobook search, and no
 * audiobook search existed. `send_ebook` was identical. Both passed every check
 * this file had, because all of them quantify over DECLARATIONS and none knew
 * that one tool's argument is another tool's output.
 *
 * So the dependency is now declared and checked, in the direction that cannot be
 * forgotten: **consuming is detected from the schema**, and a tool that requires
 * a `choice` must name the kind it needs. Then that kind must be produced by
 * something registered, or this throws at construction rather than shipping a
 * capability the model will offer and never deliver.
 *
 * ⚠️ Checked over the tools actually being registered, so the read-only build is
 * checked AS the read-only build — if a producer were a write tool it would
 * genuinely vanish when writes are off, and that would be a real hole.
 */
export function assertChoiceProducersExist(tools: Tool[]): void {
  const produced = new Set<string>();
  for (const t of tools) for (const k of t.presentsChoiceKinds ?? []) produced.add(k);

  for (const t of tools) {
    const declared = t.consumesChoiceKind;
    if (requiresChoice(t) && !declared) {
      throw new Error(
        `Tool "${t.name}" REQUIRES a "choice" argument but does not declare consumesChoiceKind. A ` +
          'choice comes from a list some other tool stored, so this tool has a dependency on that ' +
          'tool. Name the kind so the registry can check a producer exists. Not defaulted on purpose.',
      );
    }
    if (!declared || declared === '*') continue;
    if (!produced.has(declared)) {
      throw new Error(
        `Tool "${t.name}" resolves a "${declared}" choice, but NO registered tool presents one. It ` +
          'would boot, appear in the tool list, and be uncallable — which is exactly how ' +
          'add_audiobook and send_ebook shipped. Register the search tool that produces it, or ' +
          'remove this one.',
      );
    }
  }
}

/**
 * 🔴 A TOOL THAT NAMES ANOTHER TOOL IN ITS DESCRIPTION DEPENDS ON IT.
 *
 * The SECOND axis of the same defect, and it catches a different set from
 * `assertChoiceProducersExist`. Neither subsumes the other:
 *
 *  - The structural check catches `add_audiobook` and `send_ebook`, whose
 *    dependency is a `choice` in their schema. **A name scan would have missed
 *    them entirely** — `add_audiobook` says *"an audiobook search"*, which is
 *    not a tool name.
 *  - This one catches `add_movie` and `add_series`, which say *"use the tmdbId
 *    from catalogue_search"*. Their dependency is real, load-bearing, and
 *    expressed only in prose that nothing read.
 *
 * Every tool in this registry already names its producer where it has one, so
 * the declaration exists — it was just never checked. Deleting `catalogue_search`
 * now fails `add_movie` and `add_series` instead of shipping two tools whose
 * instructions point at nothing.
 *
 * ⚠️ Matched on whole `snake_case` words against the set of tool names actually
 * present, so ordinary prose cannot trip it: a name only counts as a reference
 * if some tool in this repo really is called that.
 *
 * ── 🔴 IT SCANS `scopeNote` TOO, AND THAT IS NOT AN EXTRA ────────────────────
 *
 * The coverage of this rule is defined by WHICH FIELDS IT READS, and `scopeNote`
 * is a second channel of prose that tells the model to call something by name —
 * `jellyfin_sessions`'s note says "read it with homelab_read". Adding a new way
 * to instruct the model without adding it here would have left exactly the hole
 * this function exists to close, one field along. `test/scope-note.test.ts`
 * pins that the field is scanned, so deleting it from this line fails rather
 * than silently narrowing the rule.
 *
 * ⚠️ WHAT THIS FUNCTION DOES **NOT** COVER, because it runs BEFORE the config
 * filters in `registerable()`: a tool removed by `needsServices`,
 * `needsAnyService`, `needsHomelabSsh` or `readOnly`. Its "present" set is "in
 * the source arrays", not "offered to the model". The post-filter loop at the
 * end of `registerable()` is what covers scope notes against config-driven
 * absence — do not read this one as doing that job.
 *
 * ⚠️ Lowercase-only, here and there. A note that SHOUTS a tool name — plausible
 * in this file's register — is invisible to both scans.
 */
export function assertNamedProducersExist(tools: Tool[]): void {
  const present = new Set(tools.map((t) => t.name));
  // Every tool name this repo defines, so a MISSING one is still recognised as a
  // reference. Checking only against `present` would make the rule vacuous: a
  // name that is absent would simply stop looking like a tool name.
  const known = new Set(ALL_TOOLS.map((t) => t.name));
  for (const t of tools) {
    const prose = `${t.description}\n${t.scopeNote ?? ''}`;
    const named = new Set((prose.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? []).filter((w) => known.has(w)));
    named.delete(t.name);
    for (const dep of named) {
      if (present.has(dep)) continue;
      throw new Error(
        `Tool "${t.name}" tells the model to use "${dep}", which is NOT registered. Its instructions ` +
          'would point at a tool that does not exist. Register it, or stop naming it.',
      );
    }
  }
}

/**
 * The tools a given role may use.
 *
 * ⚠️ This filters what is DECLARED. It is not the security check — the loop
 * re-checks `minRole` on every call before any side effect. Both exist on
 * purpose; do not delete the loop's check because guests never see these tools.
 */
export function toolsForRole(tools: Tool[], role: Role): Tool[] {
  return tools.filter((t) => roleSatisfies(role, t.minRole));
}

/** Every tool that exists, regardless of config. For tests and documentation. */
export const ALL_TOOLS: Tool[] = [
  ...GUEST_TOOLS,
  ...GUEST_WRITE_TOOLS,
  ...OWNER_READ_TOOLS,
  ...OWNER_WRITE_TOOLS,
  hpShell,
  makeInviteTool(INERT_INVITE),
  makeAbsInviteTool(INERT_ABS_INVITE),
  makeSendEbook(INERT_SEND_EBOOK),
  // ⚠️ `read_runbook` is registered conditionally by `buildTools` and was missing
  // from here, so every invariant quantified over ALL_TOOLS — role gating, the
  // writes declaration, the delivery-address rule — silently skipped it.
  // Reachable in production is not the same as covered by the guards.
  makeRunbookTool('/nonexistent/enumeration-only.md'),
  // ⚠️ Conditionally registered by `buildTools` (needs a TMDB token), so it has
  // the same shape as `read_runbook` and must be listed here by hand or every
  // invariant quantified over ALL_TOOLS silently skips it.
  makeTrending(),
  makeTitleDetails(),
  // ⚠️ Conditionally registered with `send_ebook` (both halves or neither), so
  // like `read_runbook` it must be hand-listed here or every invariant
  // quantified over ALL_TOOLS silently skips it.
  makeSearchEbook(),
  // ⚠️ Moved out of the unconditional arrays 2026-08-26 so the ebook flow gates
  // atomically (intake and delivery together, or neither). That move took them
  // out of ALL_TOOLS as a side effect, and TWO invariants caught it immediately:
  // registry-coverage ("defined but absent from ALL_TOOLS") and the
  // delivery-address rule, which reported that only ONE address-shaped parameter
  // was left to exercise. Conditional registration means hand-listed here — the
  // same rule as read_runbook, whats_popular and the ebook pair above.
  saveKindleEmail,
  kindleStatus,
];

export type { Tool } from './types.js';
