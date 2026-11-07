import 'dotenv/config';
import { homedir } from 'node:os';
import { EBOOK_RECHECK_MS_DEFAULT, EBOOK_RECHECK_MS_MAX, EBOOK_RECHECK_MS_MIN } from './followups.js';
import { join } from 'node:path';

/**
 * All configuration in one place, read once at boot.
 *
 * `ownerHandle` is the ONLY thing that grants administrative capability. It is
 * a boot-time constant, never something a message can change.
 */
export interface Config {
  /** Messaging handle of the single homelab owner. Everyone else is a guest. */
  ownerHandle: string;
  /**
   * 🔴 TWO ssh identities, and the separation IS the security boundary.
   *
   * `shellSshHost` is used by the free-form `hp_shell` tool and must be an
   * UNPRIVILEGED account with NO docker group membership. Then an interpreter
   * smuggled past the string filter — `awk 'BEGIN{system("docker restart …")}'`
   * — fails at the OS layer regardless of what the filter believed.
   *
   * `adminSshHost` is used only by structured tools that genuinely need docker,
   * and those carry the safety preconditions the shell cannot reach.
   *
   * If these are the same account, the boundary does not exist. That case is
   * refused at startup unless explicitly overridden — see `shellIdentityShared`.
   */
  shellSshHost: string;
  adminSshHost: string;
  /** True when the two identities are the same account, i.e. no OS-level boundary. */
  shellIdentityShared: boolean;
  /** Dev-only escape hatch permitting the shared-identity case. Never set in a deploy. */
  allowSharedSshIdentity: boolean;
  llm: {
    provider: 'ollama' | 'anthropic' | 'openai';
    baseUrl: string;
    model: string;
    apiKey?: string;
    /**
     * Wall clock for ONE model call, in ms. Absent means `TURN_TIMEOUT_MS`.
     *
     * 🔴 IT IS CONFIGURABLE BECAUSE IT HAS ALREADY BEEN CHANGED ONCE UNDER
     * PRESSURE. Jeff asked for 240s -> 900s on 2026-08-26 after a turn was
     * killed silently twice, and satisfying that took a source edit, a rebuild
     * and a redeploy of the whole bot. It is one number that governs how long a
     * person waits; it belongs in the environment.
     *
     * It is also the only honest way to EXERCISE the timeout. A test or a live
     * control can set it low and watch the abort produce a real user-facing
     * message — and a guard nobody has ever seen fire is not evidence of
     * anything. See `turn-notice.ts`.
     */
    turnTimeoutMs?: number;
  };
  jellyfin: {
    /** Base URL *including* the /jellyfin path prefix — the bare host 302s. */
    baseUrl: string;
    apiKey: string;
  };
  /**
   * ⚠️ Base URLs INCLUDE the path prefix: `http://host:8989/sonarr/api/v3`.
   * The bare host serves a web app, so a wrong URL returns 200 + HTML and reads
   * as a broken homelab when it is really a config error.
   */
  /**
   * 🔴 PROWLARR HAS NO PATH PREFIX, UNLIKE THE ARRS.
   *
   * Sonarr and Radarr live at `/sonarr/api/v3` and `/radarr/api/v3`; Prowlarr is
   * at the BARE root, `http://host:9696` + `/api/v1/...`. Measured: the prefixed
   * form returns the SPA's HTML with http 200 for `/search`, while
   * `/prowlarr/api/v1/system/status` happens to answer — so a control on the
   * wrong endpoint reports everything is fine.
   *
   * Copying the arr pattern here is the obvious mistake and it fails as UNKNOWN,
   * which reads as "Prowlarr is unreachable" rather than "your URL is wrong".
   */
  prowlarr: { baseUrl: string; apiKey: string };
  /**
   * Where "which book did they mean" is answered, before any release is ranked.
   *
   * 🔴 IT IS IN CONFIG SO THAT TESTS CAN POINT IT AT NOWHERE. Exactly the lesson
   * `shellSshHost` already carries in `test/helpers.ts`: a test seam threaded
   * through a constructor argument is only as good as every test remembering to
   * thread it, and the one that forgets reaches the REAL openlibrary.org — which
   * is slow, flaky, and rude to a free service. `testConfig` points this at an
   * `.invalid` host, so a missed seam fails to resolve and the tool degrades to
   * its documented fallback instead of quietly making a network call.
   *
   * ⚠️ NO API KEY, deliberately: Open Library needs none, so there is nothing to
   * gate registration on. The book tools work without it — worse, but they work.
   */
  openLibrary: { baseUrl: string };
  sonarr: { baseUrl: string; apiKey: string; rootFolder: string; qualityProfileId: number };
  radarr: { baseUrl: string; apiKey: string; rootFolder: string; qualityProfileId: number };
  bluebubbles: {
    /**
     * 🔴 `:1234` is JEDD (jedd@example.com). `:1235` is Jeff's PERSONAL
     * Apple ID, used to read 2FA codes. Both accept the same default password
     * and expose the same API, so a typo connects SUCCESSFULLY to the wrong
     * identity — which is why `expectedIdentity` is asserted at boot.
     */
    baseUrl: string;
    password: string;
    /**
     * 🔴 OPTIONAL IN THE TYPE, REQUIRED IN PRACTICE. There is no default: the
     * owner's Apple ID is configuration, not source. `assertIdentity` refuses to
     * start when this is absent, so the type says "may be unset" and the boot
     * says "then you do not start" — rather than a literal in the tree quietly
     * standing in for a value nobody configured.
     */
    expectedIdentity: string | undefined;
    /** Where WE listen. Loopback is correct: BlueBubbles runs on this same Mac. */
    host: string;
    port: number;
    path: string;
    /** The URL registered WITH BlueBubbles — must be reachable FROM it. */
    publicUrl: string;
  };
  /**
   * Bounds on inbound images. Every one of these is a knob on a path that
   * reaches the model, so each has a working default and none is required.
   */
  images: {
    /** Longest edge asked of BlueBubbles' server-side resize. */
    maxWidth: number;
    /** Hard ceiling, applied to the declared size AND to the bytes read. */
    maxBytes: number;
    /** Images one turn may carry, across a whole burst. */
    maxCount: number;
    /**
     * How many recent image-bearing user turns keep their bytes when the request
     * is built. See `stripStaleImages` in `agent.ts` — this is what stops a long
     * thread from accumulating pictures until it blows `num_ctx`.
     */
    historyTurns: number;
  };
  kindle: {
    smtpHost: string;
    smtpPort: number;
    /**
     * 🔴 CUTOVER INVARIANT. Amazon matches the sender against each user's
     * approved list, so a NEW from-address means E014 for every existing ebook
     * user until they each add it — which looks like nothing from our side.
     * V2 sends from the SAME address V1 sends from. Do not "tidy" this.
     *
     * ⚠️ **`KINDLE_FROM_EMAIL` IN `.env` IS AUTHORITATIVE. The literal below is
     * only a fallback for when that variable is absent — editing it alone
     * CHANGES NOTHING**, because the environment overrides it.
     *
     * That is the dangerous direction: `config.ts` is where someone looks for a
     * value, so a developer who "fixes" it here and not in `.env` gets a silent
     * no-op and believes the change landed. The warning is duplicated at both
     * edit sites deliberately; the VALUE has exactly one owner, and it is `.env`.
     */
    fromEmail: string;
    smtpPassword: string;
  };
  /**
   * SABnzbd, for Usenet ebooks only. Empty `baseUrl` or `apiKey` means Usenet
   * results are reported and not fetched. Torrent and IRC grabs do not read this.
   *
   * `storagePrefix` is the path SABnzbd writes into history `storage`.
   * `localDir` is that same folder as this process sees it, via a read-only
   * bind. Both are empty until set. There is no default directory.
   */
  sabnzbd: {
    baseUrl: string;
    apiKey: string;
    category: string;
    storagePrefix: string;
    localDir: string;
  };
  /**
   * How often a pending ebook is checked again. Other follow-ups keep their
   * own gaps. The attempt ceiling is derived from a fixed wait budget so a
   * shorter gap does not give up sooner.
   */
  ebookRecheckMs: number;
  dispatcharr: {
    baseUrl: string;
    username?: string;
    password?: string;
  };
  /**
   * jfa-go — Jellyfin account provisioning.
   *
   * 🔴 `baseUrl` is the ADMIN api and `inviteBaseUrl` is what a guest clicks.
   * They are usually the same host and they are not interchangeable — see
   * `src/jfago.ts`.
   *
   * ⚠️ `password` empty means jfa-go is NOT configured, and `invite_to_jellyfin`
   * is then **not registered at all**. Same rule as `runbookPath` and `hp_shell`:
   * an absent tool beats one that always fails, because a tool the model can see
   * is a capability it will offer.
   */
  jfago: {
    baseUrl: string;
    inviteBaseUrl: string;
    username: string;
    password: string;
    profile: string;
    validityHours: number;
  };
  /**
   * Audiobookshelf admin API — account provisioning via `invite_to_audiobookshelf`.
   *
   * ⚠️ Empty `apiKey` means ABS is NOT configured and the tool is **not registered**.
   * Prefer a non-root admin API key (revocable), never the root JWT in logs/PRs.
   */
  audiobookshelf: {
    baseUrl: string;
    apiKey: string;
    /** URL printed in the invite text; defaults to baseUrl. */
    publicUrl: string;
  };
  /**
   * The Movie Database — the only source of "what is popular", which no arr has.
   *
   * ⚠️ `readToken` is the **v4 read access token** (a ~237-character JWT sent as
   * `Authorization: Bearer`), NOT the 32-character v3 API key. Both authenticate
   * against the same v3 endpoints, so either "works" — but they are different
   * strings of very different lengths, and a value of the wrong length here is
   * the signature of one having been copied in place of the other.
   *
   * ⚠️ Empty means `whats_popular` is **not registered at all**. Same rule as
   * `runbookPath`, `jfago.password` and `hp_shell`: a tool the model can see is
   * a capability it will offer, so an absent tool beats one that always fails.
   */
  tmdb: { readToken: string };
  qbittorrent: {
    /**
     * `http://172.20.0.1:8080` — the DOCKER BRIDGE GATEWAY. qBittorrent lives in
     * gluetun-torrents' network namespace, and this is the address that works
     * from **hp itself**, which is why every tool that curls it over ssh uses
     * this one. No credentials appear here because auth-bypass is on.
     *
     * 🔴 CORRECTION 2026-08-26 — THE SENTENCE THAT USED TO BE HERE WAS WRONG.
     * It said the API "is only reachable on the bridge address, from the host
     * itself" and that "a request arriving from anywhere else gets
     * `Unauthorized`". **Measured from this Mac, unauthenticated:**
     *
     *   GET http://10.0.0.10:8080/api/v2/app/version    -> 200 in 7 ms
     *   GET http://10.0.0.10:8080/api/v2/torrents/info  -> 200, 121 torrents
     *   GET http://172.20.0.1:8080/api/v2/app/version     -> 000 after 8 s
     *
     * So the LAN address reads fine from off-host and it is the BRIDGE address
     * that is unreachable from here — the reverse of what was written. The
     * belief that there was no second transport is why `homelab-read.ts`
     * excluded qBittorrent entirely.
     *
     * ⚠️ WRITES: auth is NOT refused over the LAN either. Measured with a hash
     * that cannot exist, so nothing real could change:
     *
     *   POST http://10.0.0.10:8080/api/v2/torrents/topPrio hashes=ffff…  -> 200
     *   (control, the known-good hp path, same bogus hash)                 -> 200
     *
     * A 403 would have settled it the other way; a 200 means the request was
     * accepted rather than rejected for credentials.
     *
     * 🔴 BUT THAT 200 IS NOT EVIDENCE THE OPERATION DID ANYTHING, and the probe
     * demonstrates exactly why: it returned 200 for a torrent that does not
     * exist. The spec records the same trap for real hashes — a BATCHED
     * `topPrio` returns 200 with every priority unchanged, while per-hash calls
     * work. So any write here must assert the state BEFORE and AFTER, per hash.
     * The status code is not the outcome.
     */
    baseUrl: string;
    /**
     * The LAN address, reachable from this process. See the correction above.
     *
     * 🔴 TWO ADDRESSES FOR TWO TRANSPORTS, NEITHER CANONICAL. They are not two
     * values for one fact; they are two addresses for two callers, named for the
     * caller. Do not "tidy" them into one.
     */
    lanUrl: string;
  };
  /**
   * Read-only mode: every tool that would mutate the homelab refuses.
   * Defaults to TRUE — a misconfigured deploy is read-only, never write-enabled.
   *
   * ⚠️ This is the AUTHORISATION-independent kill switch. It is not the same axis
   * as owner-vs-guest: the owner is authorised to use write tools, and this flag
   * decides whether write tools do anything at all. Neither satisfies the other.
   */
  readOnly: boolean;
  /**
   * Path to the fetchable runbook. When unset, `read_runbook` is not registered —
   * an absent tool is better than one that always errors.
   */
  runbookPath?: string;
  /**
   * Where `indexer_admin` writes an indexer's full configuration BEFORE deleting
   * it.
   *
   * 🔴 REQUIRED, WITH A DEFAULT — deliberately not optional, unlike
   * `runbookPath`. The pattern elsewhere in this file is "no path, no tool",
   * because a tool that always errors is worse than an absent one. That is the
   * right call for a READ like the runbook and the wrong one here: making this
   * optional would mean `remove` either vanishes or, far worse, runs without a
   * capture. **The capture is what makes deletion reversible**, so there must
   * always be somewhere to put it.
   *
   * ⚠️ The files hold tracker credentials and are written 0600. It lives under
   * `~/.superbot2/` rather than the repo so a checkout, a branch switch or a
   * clean does not take the only copy of a deleted indexer's config with it.
   */
  indexerBackupDir: string;
  /**
   * Where `stuck_downloads` records what it removed from the queue, BEFORE it
   * removes it. Same discipline and same reason as `indexerBackupDir`: a
   * destructive action is made reversible rather than gated behind a prompt.
   *
   * ⚠️ It holds release titles and infohashes — not credentials — so it is less
   * sensitive than the indexer captures. It is still written 0600 in a 0700
   * directory, because the file's OTHER job is the post-grab diff: the arrs'
   * blocklist keys on release identity, NOT infohash, so the same dead torrent
   * from a different indexer passes straight back through. This file is the
   * record of what must not come back.
   */
  downloadBackupDir: string;
  /**
   * The persona name, everywhere the model or a user can see it.
   *
   * It is config because a second person running this does not want a bot that
   * introduces itself as someone else's. It is threaded rather than templated
   * at one site because it appears in the SYSTEM PROMPT, in refusal text and in
   * the ebook mail signature — three surfaces with different audiences.
   *
   * ⚠️ The `[jedd]` log prefixes are deliberately NOT derived from this. They
   * are internal diagnostics that every runbook, knowledge file and grep in
   * this project keys on; making them vary per deployment would break the one
   * thing that must stay greppable across machines.
   */
  /**
   * Did this deployment actually configure a homelab ssh host?
   *
   * 🔴 THIS GATES TWELVE TOOLS, AND IT IS DELIBERATELY A CONFIG FACT RATHER
   * THAN A REACHABILITY PROBE.
   *
   * Config presence cannot become true later: nobody set `HP_ADMIN_SSH_HOST`,
   * so there is no homelab to reach, and that is a property of the deployment.
   * Reachability is a property of THIS SECOND — a host down at 03:00 is up at
   * 03:05. Gating the registry on a live probe would silently delete twelve
   * tools from a working install because one ssh call timed out during boot,
   * and the operator would have no idea why their bot got smaller.
   *
   * So the split is: **presence decides the registry, reachability only warns.**
   * `main.ts` still probes and says loudly when a CONFIGURED host cannot be
   * reached — that is an outage worth reporting, not a reason to unregister.
   *
   * The default host name is a placeholder, so an unset variable means "not
   * configured" rather than "configured to something that happens not to exist".
   */
  homelabSshConfigured: boolean;
  /**
   * Which external services this deployment actually has. Gates the tools that
   * cannot do anything without them — see `Tool.needsServices`.
   *
   * 🔴 "CONFIGURED" IS NOT THE SAME AS "HAS A NON-EMPTY VALUE", AND TWO OF THESE
   * WOULD SILENTLY NEVER GATE IF IT WERE.
   *
   * The API keys default to `''`, so truthiness genuinely means somebody set
   * them. But `DISPATCHARR_URL` and `QBITTORRENT_LAN_URL` have NON-EMPTY
   * defaults, so `if (config.dispatcharr.baseUrl)` is true for a person who has
   * never heard of Dispatcharr. That gate would look right in review and do
   * nothing. Both therefore test the ENVIRONMENT VARIABLE, the same distinction
   * `homelabSshConfigured` draws.
   *
   * ⚠️ Dispatcharr is URL-only ON PURPOSE. Its username/password are unset on
   * the live deployment and it works regardless; gating on credentials would
   * have deleted `channel_health` and `livetv_status` from a working install —
   * fixing a publication problem by breaking somebody's setup.
   */
  services: {
    sonarr: boolean;
    radarr: boolean;
    prowlarr: boolean;
    jellyfin: boolean;
    qbittorrent: boolean;
    dispatcharr: boolean;
    audiobookshelf: boolean;
  };
  displayName: string;
  /**
   * Where audiobook grabs land in qBittorrent, and under what category.
   *
   * 🔴 BOTH MATTER AND THEY ARE NOT REDUNDANT. The category is what the mover
   * script watches; the save path is what actually places the file. A category
   * alone does not move anything. They are configuration because they are a
   * contract with a script that lives OUTSIDE this repo, on the download host.
   */
  audiobook: { savePath: string; category: string };
  /**
   * Where the `check-streams` script writes its results ON the homelab host.
   *
   * Configuration for the same reason as `audiobook` above: it is the interface
   * to a script this repo does not ship, so its path is a property of the
   * deployment rather than of this code.
   */
  checkStreamsResultsPath: string;
  /**
   * The IRC network, channel and nick used for ebook fetching.
   *
   * 🔴 `nick` is the one that MUST be configurable: two people running this
   * against the same network collide on the same nick, and the second one gets
   * renamed or rejected by the server. Channel and host follow for the same
   * reason a second operator may not want this network at all.
   *
   * ⚠️ The TIMING constants next to these in `irc-ebooks.ts` are deliberately
   * NOT config — `joinDelayMs` (~65-70s before irchighway accepts a JOIN) and
   * `searchTimeoutMs` (90s, pinned by a test above the slowest MEASURED reply)
   * are facts about that server's behaviour, not preferences. Exposing them
   * would just let someone set a value that looks reasonable and silently
   * breaks the search.
   */
  irc: { host: string; port: number; channel: string; nick: string };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * 🔴 REQUIRED IN `.env`, AND `.env` IS NOT IN GIT.
 *
 * These have NO default and the process refuses to start without them. The list
 * exists because the failure is loud but the RECOVERY is not: if `.env` is ever
 * lost, whoever rebuilds it needs to know which values are mandatory, and a
 * refusal names only the first one it hits.
 *
 *   OWNER_HANDLE           — who the owner is. `loadConfig` throws without it.
 *   BLUEBUBBLES_IDENTITY   — which Apple ID this deployment may text from.
 *                            `assertIdentity` throws without it: both servers on
 *                            this host share a password and an API shape, so an
 *                            unset value would connect SUCCESSFULLY to the wrong
 *                            account.
 *
 * ⚠️ NAMES ONLY, NEVER VALUES. This file is committed. A secret written here to
 * be helpful is a secret in the repository, in every clone, forever.
 */
/** Narrowest value `LLM_TURN_TIMEOUT_MS` may take. Below this every turn dies. */
export const MIN_TURN_TIMEOUT_MS = 1_000;
/** Widest. An hour per model call is already eight hours of turn at MAX_STEPS. */
export const MAX_TURN_TIMEOUT_MS = 3_600_000;

/**
 * `LLM_TURN_TIMEOUT_MS` -> ms, or `undefined` to mean "use the built-in".
 *
 * 🔴 EMPTY, GARBAGE, ZERO AND NEGATIVE ALL FALL BACK, THEY DO NOT PARSE TO
 * SOMETHING SMALL. V1 learned this on `OLLAMA_NUM_CTX`: a variable that reads as
 * a number when it is nonsense is how a deployment quietly acquires a setting
 * nobody chose. Here the nonsense reading would be a timeout of 0 — every single
 * turn killed the instant it starts, on a build that looks configured.
 *
 * Out-of-range values are CLAMPED rather than rejected, and the clamp is
 * announced by the caller. A refusal to boot over a tuning knob would trade a
 * slow bot for no bot.
 */
export function parseTurnTimeout(raw: string | undefined): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.round(n)));
}

/**
 * A positive integer from the environment, or the default.
 *
 * ⚠️ NONSENSE FALLS BACK RATHER THAN COERCING, for the reason written out above
 * `parseTurnTimeout`: `Number('')` is 0 and `Number('1024px')` is NaN, and a
 * setting that reads as a number when it is not is how a deployment quietly
 * acquires a value nobody chose. Here the nonsense readings would be an image
 * ceiling of zero bytes — every photo rejected as oversize, on a build that
 * looks configured.
 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  /**
   * ⚠️ CLAMPED AT THE TOP TOO, the same as `parseTurnTimeout` above. Without it
   * `JEDD_IMAGE_MAX_BYTES=999999999` is accepted and `readCapped` will buffer
   * every one of those bytes in memory before deciding anything — a ceiling that
   * is the absence of a ceiling, on a build that looks configured.
   */
  return Math.min(max, Math.round(n));
}

export function loadConfig(): Config {
  const provider = (process.env.LLM_PROVIDER ?? 'ollama') as 'ollama' | 'anthropic' | 'openai';
  // A hostname is deployment configuration; `.env` is authoritative and this
  // literal is only the fallback for a fresh install.
  const adminSshHost = process.env.HP_ADMIN_SSH_HOST ?? 'homelab';
  // Defaults to the admin host so a missing variable is CONSPICUOUS (it trips the
  // shared-identity refusal) rather than silently pointing somewhere unexpected.
  // `??` does NOT fire on an empty string, so an unset-but-present variable used
  // to sail through the inequality check as a "different" host. Trim first.
  const shellSshHost = (process.env.HP_SHELL_SSH_HOST ?? '').trim() || adminSshHost;
  const turnTimeoutMs = parseTurnTimeout(process.env.LLM_TURN_TIMEOUT_MS);
  return {
    ownerHandle: required('OWNER_HANDLE'),
    shellSshHost,
    adminSshHost,
    shellIdentityShared: shellSshHost === adminSshHost,
    allowSharedSshIdentity: process.env.JEDD_ALLOW_SHARED_SSH_IDENTITY === 'true',
    llm: {
      provider,
      baseUrl:
        process.env.LLM_BASE_URL ??
        (provider === 'anthropic'
          ? 'https://api.anthropic.com'
          : provider === 'openai'
            ? 'http://localhost:8000/v1'
            : 'http://localhost:11434'),
      model: process.env.LLM_MODEL ?? 'qwen3.8:27b',
      apiKey: process.env.LLM_API_KEY,
      ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
    },
    jellyfin: {
      baseUrl: process.env.JELLYFIN_URL ?? 'http://localhost:8096/jellyfin',
      apiKey: process.env.JELLYFIN_API_KEY ?? '',
    },
    prowlarr: {
      baseUrl: process.env.PROWLARR_URL ?? 'http://10.0.0.10:9696',
      apiKey: process.env.PROWLARR_API_KEY ?? '',
    },
    openLibrary: { baseUrl: process.env.OPEN_LIBRARY_URL ?? 'https://openlibrary.org' },
    sonarr: {
      baseUrl: process.env.SONARR_URL ?? 'http://10.0.0.10:8989/sonarr/api/v3',
      apiKey: process.env.SONARR_API_KEY ?? '',
      /**
       * ⚠️ `.env` IS AUTHORITATIVE; the literals here are only the fallback for
       * a fresh install (same rule as `kindle.fromEmail` below). Editing them
       * alone changes NOTHING for a deploy whose `.env` sets these.
       *
       * These are a LIBRARY LAYOUT and a PROFILE NUMBERING, both of which are
       * true only of one Sonarr. Profile ids especially: `9` is whatever the
       * ninth profile happens to be on this instance and is meaningless on
       * anyone else's. A wrong value here does not error — Sonarr accepts it
       * and files the show into the wrong place at the wrong quality, and
       * nobody finds out until someone goes looking for it. Profile 1 exists
       * on every fresh *arr, so it is the safe generic default.
       */
      rootFolder: process.env.SONARR_ROOT_FOLDER ?? '/media/tv',
      qualityProfileId: Number(process.env.SONARR_QUALITY_PROFILE_ID ?? 1),
    },
    radarr: {
      baseUrl: process.env.RADARR_URL ?? 'http://10.0.0.10:7878/radarr/api/v3',
      apiKey: process.env.RADARR_API_KEY ?? '',
      // Same rule as Sonarr above: `.env` wins, and a wrong value here fails
      // SILENTLY into the wrong folder rather than erroring.
      rootFolder: process.env.RADARR_ROOT_FOLDER ?? '/media/movies',
      qualityProfileId: Number(process.env.RADARR_QUALITY_PROFILE_ID ?? 1),
    },
    bluebubbles: {
      baseUrl: process.env.BLUEBUBBLES_URL ?? 'http://127.0.0.1:1234',
      password: process.env.BLUEBUBBLES_PASSWORD ?? 'password',
      /**
       * 🔴 NO DEFAULT, ON PURPOSE. The owner's Apple ID is configuration, not
       * source — and an absent value must not become a permissive one.
       * `assertIdentity` REFUSES to start when this is unset, because ports 1234
       * and 1235 share a password and an API shape, so an unconfigured
       * deployment connects *successfully* to the wrong identity and texts from
       * the wrong person. Set BLUEBUBBLES_IDENTITY in .env.
       */
      expectedIdentity: process.env.BLUEBUBBLES_IDENTITY,
      host: process.env.BLUEBUBBLES_WEBHOOK_HOST ?? '127.0.0.1',
      port: Number(process.env.BLUEBUBBLES_WEBHOOK_PORT ?? 18796),
      path: process.env.BLUEBUBBLES_WEBHOOK_PATH ?? '/webhook',
      publicUrl:
        process.env.BLUEBUBBLES_WEBHOOK_URL ??
        `http://${process.env.BLUEBUBBLES_WEBHOOK_HOST ?? '127.0.0.1'}:${
          process.env.BLUEBUBBLES_WEBHOOK_PORT ?? 18796
        }${process.env.BLUEBUBBLES_WEBHOOK_PATH ?? '/webhook'}`,
    },
    images: {
      maxWidth: parsePositiveInt(process.env.JEDD_IMAGE_MAX_WIDTH, 1024, 4096),
      maxBytes: parsePositiveInt(process.env.JEDD_IMAGE_MAX_BYTES, 12 * 1024 * 1024, 64 * 1024 * 1024),
      maxCount: parsePositiveInt(process.env.JEDD_IMAGE_MAX_COUNT, 4, 16),
      historyTurns: parsePositiveInt(process.env.JEDD_IMAGE_HISTORY_TURNS, 2, 8),
    },
    kindle: {
      smtpHost: process.env.KINDLE_SMTP_HOST ?? 'smtp.gmail.com',
      smtpPort: Number(process.env.KINDLE_SMTP_PORT ?? 587),
      // ⚠️ The default here was a real address AND was already dead: .env has
      // set KINDLE_FROM_EMAIL all along, so env won and editing the literal
      // would have changed nothing. An empty value is refused by send_ebook.
      fromEmail: process.env.KINDLE_FROM_EMAIL ?? '',
      smtpPassword: process.env.KINDLE_SMTP_PASSWORD ?? '',
    },
    sabnzbd: {
      // No default URL. A guessed host would look configured and is not.
      baseUrl: (process.env.SABNZBD_URL ?? '').trim().replace(/\/+$/, ''),
      apiKey: (process.env.SABNZBD_API_KEY ?? '').trim(),
      category: (process.env.SABNZBD_CATEGORY ?? 'jedd-ebooks').trim() || 'jedd-ebooks',
      storagePrefix: (process.env.SABNZBD_STORAGE_PREFIX ?? '').trim(),
      localDir: (process.env.SABNZBD_LOCAL_DIR ?? '').trim(),
    },
    ebookRecheckMs: Math.max(
      EBOOK_RECHECK_MS_MIN,
      parsePositiveInt(process.env.EBOOK_RECHECK_MS, EBOOK_RECHECK_MS_DEFAULT, EBOOK_RECHECK_MS_MAX),
    ),
    dispatcharr: {
      baseUrl: process.env.DISPATCHARR_URL ?? 'http://localhost:9191',
      username: process.env.DISPATCHARR_USER,
      password: process.env.DISPATCHARR_PASSWORD,
    },
    jfago: {
      baseUrl: process.env.JFAGO_URL ?? '',
      // Defaults to the admin base, which is correct for jfa-go: the same
      // url_base serves both surfaces. It is a separate variable so a deploy
      // that fronts them differently does not have to lie about one of them.
      inviteBaseUrl: process.env.JFAGO_PUBLIC_URL ?? process.env.JFAGO_URL ?? '',
      username: process.env.JFAGO_USER ?? '',
      password: process.env.JFAGO_PASSWORD ?? '',
      profile: process.env.JFAGO_PROFILE ?? 'Default',
      validityHours: Number(process.env.JFAGO_INVITE_HOURS ?? 24),
    },
    audiobookshelf: {
      baseUrl: (process.env.ABS_URL ?? '').replace(/\/$/, ''),
      apiKey: process.env.ABS_API_KEY ?? '',
      publicUrl: (process.env.ABS_PUBLIC_URL ?? process.env.ABS_URL ?? '').replace(/\/$/, ''),
    },
    tmdb: { readToken: (process.env.TMDB_READ_TOKEN ?? '').trim() },
    qbittorrent: {
      baseUrl: process.env.QBITTORRENT_URL ?? 'http://172.20.0.1:8080',
      lanUrl: process.env.QBITTORRENT_LAN_URL ?? 'http://10.0.0.10:8080',
    },
    // Opt IN to writes, explicitly. Absence of the flag means read-only.
    readOnly: process.env.JEDD_ALLOW_WRITES !== 'true',
    runbookPath: process.env.RUNBOOK_PATH,
    indexerBackupDir:
      process.env.INDEXER_BACKUP_DIR ?? join(homedir(), '.superbot2', 'backups', 'prowlarr-indexers'),
    downloadBackupDir:
      process.env.DOWNLOAD_BACKUP_DIR ?? join(homedir(), '.superbot2', 'backups', 'removed-downloads'),
    // Explicitly SET, not merely defaulted — see the field's doc comment.
    homelabSshConfigured: Boolean((process.env.HP_ADMIN_SSH_HOST ?? '').trim()),
    services: {
      // Keys default to '' — truthiness is a real signal here.
      sonarr: Boolean((process.env.SONARR_API_KEY ?? '').trim()),
      radarr: Boolean((process.env.RADARR_API_KEY ?? '').trim()),
      prowlarr: Boolean((process.env.PROWLARR_API_KEY ?? '').trim()),
      jellyfin: Boolean((process.env.JELLYFIN_API_KEY ?? '').trim()),
      audiobookshelf: Boolean((process.env.ABS_API_KEY ?? '').trim()),
      // 🔴 These two have NON-EMPTY defaults, so the env var is the only honest
      // test of whether anyone configured them.
      qbittorrent: Boolean((process.env.QBITTORRENT_LAN_URL ?? '').trim()),
      dispatcharr: Boolean((process.env.DISPATCHARR_URL ?? '').trim()),
    },
    displayName: process.env.DISPLAY_NAME ?? 'Jedd',
    audiobook: {
      savePath: process.env.AUDIOBOOK_SAVE_PATH ?? '/downloads/audiobooks',
      category: process.env.AUDIOBOOK_CATEGORY ?? 'audiobooks',
    },
    checkStreamsResultsPath:
      process.env.CHECK_STREAMS_RESULTS_PATH ?? '/tmp/check-streams-results.txt',
    irc: {
      host: process.env.IRC_HOST ?? 'irc.irchighway.net',
      port: Number(process.env.IRC_PORT ?? 6667),
      channel: process.env.IRC_CHANNEL ?? '#ebooks',
      nick: process.env.IRC_NICK ?? 'jeddbot',
    },
  };
}

/**
 * Is the free-form shell safe to offer at all?
 *
 * Returns a reason when it is not. The caller must then NOT register `hp_shell`
 * — an absent tool cannot be argued for, and this is the one place where the
 * string filter is known to be insufficient on its own.
 */
export function assertShellIdentityIsSafe(config: Config): { safe: boolean; reason: string } {
  if (!config.shellIdentityShared) {
    return {
      safe: true,
      reason: `shell runs as "${config.shellSshHost}", docker actions as "${config.adminSshHost}"`,
    };
  }
  if (config.allowSharedSshIdentity) {
    return {
      safe: true,
      reason:
        `⚠️ UNSAFE: hp_shell and docker actions share the ssh identity "${config.adminSshHost}". ` +
        'The command filter is the ONLY thing preventing arbitrary container control, and a filter ' +
        'over command text is known to be defeatable. Permitted only because ' +
        'JEDD_ALLOW_SHARED_SSH_IDENTITY=true. NEVER set this in a deploy.',
    };
  }
  return {
    safe: false,
    reason:
      `hp_shell is DISABLED: HP_SHELL_SSH_HOST is unset or equal to HP_ADMIN_SSH_HOST ` +
      `("${config.adminSshHost}"), so the shell would run with docker privileges. Provision an ` +
      'unprivileged ssh account on hp with no docker group membership and set HP_SHELL_SSH_HOST ' +
      'to it. To run anyway during development, set JEDD_ALLOW_SHARED_SSH_IDENTITY=true.',
  };
}
