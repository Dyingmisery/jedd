/**
 * The BlueBubbles HTTP surface.
 *
 * Every trap encoded here was measured against the live server, not read from
 * documentation. See `knowledge/bluebubbles-connector.md` in the space.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * iMessage has no renderer, so markdown ships as literal punctuation: a reply
 * reading `**Dune** is ready` arrives with the asterisks visible.
 *
 * Deliberately conservative. This runs on EVERY outbound message, so an
 * over-eager rule corrupts real text — a title like `*batteries not included`
 * or a path like `some_file_name` must survive. It strips only the markers that
 * wrap content, and leaves anything it is unsure about alone. **Stripping is a
 * cosmetic fix; mangling a title is a correctness bug**, so the asymmetry
 * decides the default.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')   // fenced blocks
    .replace(/`([^`\n]+)`/g, '$1')                  // inline code
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')           // bold
    .replace(/__([^_\n]+)__/g, '$1')                // bold (underscore)
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)') // links keep the url
    .replace(/^#{1,6}\s+/gm, '')                    // headings
    .replace(/^\s*[-*]\s+/gm, '• ')                 // bullets
    .trim();
}

/**
 * The chat guid for a 1:1 conversation with `handle`.
 *
 * ⚠️ ONE OWNER FOR THIS STRING. Sending, typing and read receipts all address
 * the same conversation, and three inlined copies of `iMessage;-;${x}` are three
 * places for the form to drift — with the drift invisible, because each one
 * looks right on its own and only the *pairing* is wrong. A typing indicator
 * that lands on a different guid from the reply is a stuck indicator on one
 * thread and a silent one on another.
 *
 * 🔴 THIS IS 1:1 ONLY, exactly like `sendText`. V1 had no group support and V2
 * has not added any: a message from a group thread is answered as a stray DM to
 * the sender, and these presence signals inherit that same limitation rather
 * than quietly inventing a second addressing scheme. See the "Group chats"
 * section of `knowledge/bluebubbles-connector.md`.
 *
 * ⚠️ THE CONSTRUCTED FORM IS THE FALLBACK, NOT THE ANSWER. On this server the
 * threads that exist are `any;-;<handle>` (measured 2026-09-17: all 71 threads,
 * zero `iMessage;-;`), so a send addressed to this string 500s. Callers address
 * threads through `resolveChatGuid()`, which falls back to this when it cannot
 * read the live one — so this stays the single owner of the constructed form
 * and the fallback never behaves differently from the old code.
 */
export function chatGuidFor(handle: string): string {
  return `iMessage;-;${handle}`;
}

/**
 * The E.164 form of a US phone number, for matching against the form
 * BlueBubbles writes into `chatIdentifier` and `participants[].address`.
 *
 * 🔴 WHY THIS EXISTS. Those fields carry `+1XXXXXXXXXX` (measured 2026-09-22
 * against the live `:1234`), but a person types a number the way they wrote it
 * in a message — `(801) 555-4271`, `801 687 4271`, `+1801…`. A lookup keyed on
 * the raw string finds nothing, falls back to the constructed guid, and the
 * send 500s. This maps the raw form onto the one the server stores, so either
 * spelling finds the same thread.
 *
 * Only 10-digit national numbers canonicalize. Anything else — an existing
 * `+1XXXXXXXXXX` form, an 11-digit ambiguity, a non-US number, a non-phone
 * string — returns `null` and the caller keeps its exact-match behaviour
 * unchanged.
 */
export function canonicalPhone(handle: string): string | null {
  const digits = handle.replace(/[^\d]/g, '');
  if (digits.length === 10) {
    // A bare 10-digit national number reads as the US number the server
    // stores as +1XXXXXXXXXX.
    return `+1${digits}`;
  }
  // 11 digits with a leading +1 IS the stored spelling — return it unchanged
  // (the caller's exact match already covers it; a second form would be a
  // fake spelling, e.g. +11801… that matches nothing). Anything else —
  // 11 bare digits, a non-US number, a non-phone string — returns null and
  // the caller keeps its exact-match behaviour unchanged.
  if (digits.length === 11 && handle.startsWith('+1')) return handle;
  return null;
}

/**
 * What a Private API call did.
 *
 * 🔴 `helperAbsent` IS A FIRST-CLASS OUTCOME, NOT AN ERROR.
 *
 * Typing indicators and read receipts are the only BlueBubbles operations that
 * require the Private API helper bundle, and the helper only loads with SIP
 * disabled. Measured on this server 2026-08-25 with `helper_connected: false`:
 *
 *     POST   /api/v1/chat/{guid}/typing  → 500 in ~7ms
 *     DELETE /api/v1/chat/{guid}/typing  → 500 in ~3ms
 *     POST   /api/v1/chat/{guid}/read    → 500 in ~3ms
 *     {"status":500,
 *      "message":"Please make sure you have completed the setup for the Private
 *                 API, and your helper is connected!",
 *      "error":{"type":"iMessage Error",
 *               "message":"iMessage Private API Helper is not connected!"}}
 *
 * It **fails fast and never hangs** — BlueBubbles' `restrictedPrivateApi`
 * middleware runs the check *before* the controller touches the helper socket,
 * so nothing waits on a connection that is not there. That is why this is a
 * cheap thing to attempt on every turn.
 *
 * Distinguishing it matters because it will be the outcome of EVERY call until
 * SIP is disabled, and a caller that cannot tell it apart from a real fault will
 * either log an error twelve times a day about a known, expected, harmless
 * condition — or learn to ignore the log, which is worse.
 */
export interface PrivateApiResult {
  ok: boolean;
  status: number;
  /** The helper bundle is not loaded. Expected until SIP is disabled. */
  helperAbsent: boolean;
  detail: string;
}

export interface BlueBubblesOptions {
  baseUrl: string;
  password: string;
  /**
   * 🔴 The Apple account this server MUST be bridging.
   *
   * There are two BlueBubbles servers on the Mac: `:1234` is Jedd
   * (`jedd@example.com`) and `:1235` is Jeff's PERSONAL account, used by
   * the orchestrator to read 2FA codes. **Both use the literal default password
   * and expose the same API**, so a copy-pasted `.env` connects *successfully*
   * to the wrong identity and Jedd texts from the wrong person. Nothing about
   * that failure looks like an error, which is why it is checked at boot.
   */
  expectedIdentity?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /**
   * Test seam for the clock. The guid cache is the only thing that reads it,
   * and its two TTLs differ by 25 minutes — a difference no test can observe
   * without travelling. Left unset, this is `Date.now`.
   *
   * 🔴 It exists because a mutation sweep proved the need: collapsing the
   * miss TTL into the hit TTL SURVIVED the suite (2026-09-17), because every
   * test asked its second question immediately, where both TTLs agree.
   */
  nowImpl?: () => number;
}

export interface ServerInfo {
  detectedIMessage: string;
  serverVersion: string;
  /**
   * 🔴 THESE TWO ARE NOT THE SAME QUESTION, AND EITHER ONE ALONE LIES.
   *
   * `privateApiEnabled` is a SETTING in BlueBubbles' own config.
   * `helperConnected` is whether the helper dylib is actually loaded into
   * Messages.app, which only happens with SIP disabled.
   *
   * Measured on this server 2026-08-25: `true` and `false` respectively. Reading
   * only the first would say the Private API is on — and every typing indicator
   * and read receipt would still fail. The pair is the state.
   */
  privateApiEnabled: boolean;
  helperConnected: boolean;
}

export interface SendResult {
  /** The server took it without an error code. NOT a delivery claim. */
  accepted: boolean;
  guid: string | null;
  /** Three-state. `unknown` is not a "no". */
  delivery: DeliveryVerdict;
  detail: string;
}

export type DeliveryVerdict = 'delivered' | 'failed' | 'unknown';

export interface ReplayResult {
  /** Oldest first, so they can be fed through the normal path in order. */
  messages: Record<string, unknown>[];
  /**
   * True when the walk hit its page budget before reaching the watermark, i.e.
   * the replay is INCOMPLETE. V1 loses these silently; this says so.
   */
  saturated: boolean;
  pages: number;
}

/** How many pages `replaySince` will walk before declaring saturation. */
export const MAX_REPLAY_PAGES = 20;
const PAGE_SIZE = 100;

/**
 * Engine.IO v4 packs several packets into one polling response and separates
 * them with an ASCII record separator (0x1e). Named because that byte written
 * literally into a `split` is invisible on screen and reads as a typo.
 * See `socketEmit`.
 */
const SOCKET_IO_RECORD_SEPARATOR = '\u001e';

export class BlueBubblesClient {
  private readonly fetchImpl: FetchImpl;

  private readonly timeoutMs: number;

  /** See `BlueBubblesOptions.nowImpl`. Only the guid cache reads the clock. */
  private readonly now: () => number;

  /** Resolved live chat guids, per handle. Bounded in practice by the number of threads. */
  private readonly guidCache = new Map<string, { guid: string; at: number; hit: boolean }>();

  constructor(private readonly opts: BlueBubblesOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.nowImpl ?? (() => Date.now());
  }

  private url(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.opts.baseUrl}/api/v1${path}${sep}password=${encodeURIComponent(this.opts.password)}`;
  }

  /**
   * Every request is bounded. V1's `postText` has NO timeout at all, so a hung
   * BlueBubbles blocks it forever — and the attachment endpoint is the proven
   * case, hanging >90s with no response for an unreachable recipient while the
   * text endpoint fails fast in ~1s. Do not assume one endpoint's timing
   * generalises to another.
   */
  private async call(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  private static data(body: unknown): unknown {
    return (body as { data?: unknown } | null)?.data;
  }

  async serverInfo(): Promise<ServerInfo> {
    const { status, body } = await this.call('/server/info');
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    const detected = typeof d?.['detected_imessage'] === 'string' ? d['detected_imessage'] : '';
    if (status >= 400 || !detected) {
      throw new Error(
        `Could not read BlueBubbles server identity (http ${status}). This is UNKNOWN, not "probably ` +
          'the right server" — refusing to start rather than risk texting from the wrong Apple account.',
      );
    }
    return {
      detectedIMessage: detected,
      serverVersion: String(d?.['server_version'] ?? 'unknown'),
      // Strict `=== true`: an absent or unparseable field is NOT a capability.
      privateApiEnabled: d?.['private_api'] === true,
      helperConnected: d?.['helper_connected'] === true,
    };
  }

  /** Refuse to run against the wrong Apple account. Throws; the caller must not catch it. */
  async assertIdentity(): Promise<ServerInfo> {
    const info = await this.serverInfo();
    const want = this.opts.expectedIdentity;
    /**
     * 🔴 AN UNCONFIGURED IDENTITY IS A REFUSAL, NOT A PASS.
     *
     * This read `if (want && ...)`, so an absent value SKIPPED the check
     * entirely — and it went unnoticed because a hardcoded default was standing
     * in for the config. Removing that default (the owner's address does not
     * belong in source) would have turned a cosmetic fix into a silent safety
     * regression: both servers on this host accept the same password and expose
     * the same API, so with no expectation Jedd would connect happily to the
     * personal account and text from the wrong Apple ID.
     */
    if (!want) {
      throw new Error(
        `NO EXPECTED IMESSAGE IDENTITY CONFIGURED, and ${this.opts.baseUrl} is bridging ` +
          `"${info.detectedIMessage}". Both BlueBubbles servers on this host accept the same ` +
          'password and expose the same API, so an unset expectation connects SUCCESSFULLY to the ' +
          'wrong Apple ID. Set BLUEBUBBLES_IDENTITY. Refusing to start.',
      );
    }
    if (info.detectedIMessage.toLowerCase() !== want.toLowerCase()) {
      throw new Error(
        `WRONG BLUEBUBBLES SERVER: ${this.opts.baseUrl} is bridging "${info.detectedIMessage}", ` +
          `but this deployment expects "${want}". Both servers on this host accept the same ` +
          'password and expose the same API, so this connects successfully to the wrong identity. ' +
          'Refusing to start.',
      );
    }
    return info;
  }

  async listWebhooks(): Promise<{ id: number; url: string; events: string[] }[]> {
    const { body } = await this.call('/webhook');
    const rows = BlueBubblesClient.data(body);
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const ev = row['events'];
      return {
        id: Number(row['id']),
        url: String(row['url'] ?? ''),
        events: Array.isArray(ev) ? ev.map(String) : typeof ev === 'string' ? [ev] : [],
      };
    });
  }

  /**
   * Register our webhook, removing any stale row that points at us-but-elsewhere.
   *
   * 🔴 V1 dedups by exact URL string and only ever ADDS. When the registered URL
   * changed (loopback → LAN IP) it left an ORPHAN pointing at an unreachable
   * address, and **nothing failed loudly** — BlueBubbles delivered into a black
   * hole for an entire version. Registration has to converge on one row.
   *
   * ── 🔴 "OURS" IS PORT + PATH. IT WAS PATH ALONE, AND THAT WAS A LANDMINE. ───
   *
   * The staleness rule used to match on PATHNAME only, so any row ending
   * `/webhook` was fair game to delete. Live registrations on this server right
   * now:
   *
   *     id 5  http://10.0.0.10:18790/webhook    ← V1. Production. Serving a household.
   *     id 9  http://127.0.0.1:18795/webhook      ← a V2 listener
   *
   * Both are `/webhook`, because `/webhook` is what everybody calls it. Under
   * the old rule, **V2 starting up would have silently deleted V1's
   * registration** and taken the live Jedd off the air — with no log line saying
   * so, because from the code's point of view it was tidying up after itself.
   *
   * That is the right thing to do at CUTOVER and a catastrophe at every other
   * moment, and the difference is not something the registration path can see.
   * So it no longer guesses: a row on a **different port is somebody else's**,
   * and we do not delete other people's registrations. The original incident is
   * still covered, because a host change (`127.0.0.1:18790` → `10.0.0.10:18790`)
   * keeps the port.
   *
   * Taking V1 down is a DELIBERATE, SEPARATE step — `deleteWebhook(5)` in the
   * runbook, recorded before it is done so it can be undone.
   *
   * ⚠️ Returns what it did. A removal that nobody logs is the orphan bug wearing
   * the opposite sign.
   */
  async ensureWebhook(
    url: string,
    events: string[],
  ): Promise<{ outcome: 'already-registered' | 'created'; removed: { id: number; url: string }[] }> {
    const existing = await this.listWebhooks();
    if (existing.some((w) => w.url === url)) return { outcome: 'already-registered', removed: [] };

    const mine = BlueBubblesClient.endpointKey(url);
    const removed: { id: number; url: string }[] = [];
    for (const w of existing) {
      if (w.url !== url && BlueBubblesClient.endpointKey(w.url) === mine) {
        await this.call(`/webhook/${w.id}`, { method: 'DELETE' });
        removed.push({ id: w.id, url: w.url });
      }
    }
    await this.call('/webhook', { method: 'POST', body: JSON.stringify({ url, events }) });
    return { outcome: 'created', removed };
  }

  /**
   * `port:path` — what makes a registration OURS across a host change.
   *
   * A malformed URL falls back to the whole string, which can only ever match
   * itself. That is the fail-closed direction: an unparseable row is never
   * mistaken for one of ours and deleted.
   */
  private static endpointKey(url: string): string {
    try {
      const u = new URL(url);
      return `${u.port}:${u.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Remove one registration by id. The DOWN step of a cutover, and the thing
   * that undoes an UP step.
   *
   * 🔴 Deliberately takes an ID, not a URL. Deleting a webhook is how the live
   * Jedd is taken off the air, and that is not an action anything should perform
   * as a side effect of matching a pattern — the caller has to have looked at the
   * list and named the row.
   */
  async deleteWebhook(id: number): Promise<{ ok: boolean; status: number }> {
    const { status } = await this.call(`/webhook/${id}`, { method: 'DELETE' });
    return { ok: status >= 200 && status < 300, status };
  }

  /**
   * The newest `originalROWID` the server knows about, for seeding a watermark.
   *
   * 🔴 EXISTS SO A FIRST BOOT DOES NOT REPLY TO HISTORY. See
   * `BlueBubblesReceiver.replayMissed()` — a virgin `SeenStore` has watermark 0,
   * and replaying from 0 would walk back up to 20 pages and hand every one of
   * those messages to the agent as if it had just arrived.
   *
   * `null` when the server cannot be read or has no messages. The caller must
   * treat that as "do not know", never as 0 — 0 is the value that causes the
   * flood.
   */
  async newestRowid(): Promise<number | null> {
    const { body } = await this.call('/message/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 1, sort: 'DESC', with: ['handle'] }),
    });
    const rows = BlueBubblesClient.data(body);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const raw = (rows[0] as Record<string, unknown>)['originalROWID'];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Everything after `sinceRowid`, oldest first, paging until the watermark is
   * reached or the page budget runs out.
   *
   * 🔴 V1 queries `limit:50` with NO pagination and filters client-side, so an
   * outage longer than 50 messages loses the older ones permanently — and says
   * nothing. Saturation here is reported, not hidden.
   */
  async replaySince(sinceRowid: number): Promise<ReplayResult> {
    const collected: Record<string, unknown>[] = [];
    let pages = 0;
    let saturated = true;

    for (; pages < MAX_REPLAY_PAGES; pages++) {
      const { body } = await this.call('/message/query', {
        method: 'POST',
        body: JSON.stringify({
          limit: PAGE_SIZE,
          offset: pages * PAGE_SIZE,
          sort: 'DESC',
          with: ['handle', 'chat'],
        }),
      });
      const rows = BlueBubblesClient.data(body);
      if (!Array.isArray(rows) || rows.length === 0) {
        saturated = false; // ran out of history: the walk is complete
        break;
      }
      let reachedWatermark = false;
      for (const r of rows as Record<string, unknown>[]) {
        const rowid = Number(r['originalROWID']);
        if (Number.isFinite(rowid) && rowid <= sinceRowid) {
          reachedWatermark = true;
          break;
        }
        collected.push(r);
      }
      if (reachedWatermark) {
        saturated = false;
        break;
      }
      if (rows.length < PAGE_SIZE) {
        saturated = false;
        break;
      }
    }

    collected.sort((a, b) => Number(a['originalROWID']) - Number(b['originalROWID']));
    return { messages: collected, saturated, pages };
  }

  /**
   * The LIVE chat guid for the conversation with `handle`, from the server's
   * own chat list.
   *
   * 🔴 WHY THIS EXISTS. The send path used to address `chatGuidFor(handle)` —
   * the constructed `iMessage;-;<handle>` — and on this server that 500s,
   * because the thread BlueBubbles actually wrote is `any;-;<handle>`. Measured
   * 2026-09-17 against the live `:1234`: all 71 local threads carry the `any;-;`
   * prefix and zero carry `iMessage;-;`. A send addressed to the constructed
   * guid never reaches the thread, so the reply is lost and the turn then
   * apologises to a person who thinks the message arrived. This asks the server
   * which guid the thread HAS.
   *
   * 🔴 IT NEVER THROWS, AND THE FALLBACK IS EXACTLY THE OLD BEHAVIOUR. A
   * refused request, an unreadable body, an empty list, or a transport failure
   * all land on `chatGuidFor(handle)` — the string the old code sent — so no
   * failure mode of this lookup is worse than the status quo it replaces, and a
   * miss can never turn an answerable question into a delivery failure notice.
   * (A miss is cached briefly, not forever: the thread can appear later.)
   *
   * 🔴 ONE RESOLUTION FEEDS EVERYTHING THAT ADDRESSES THE THREAD. `sendText`,
   * `recentlySent`'s look-back, and `Presence`'s typing/read receipts all pass
   * the returned guid to BlueBubbles, so a reply, its dedup read and its
   * indicator land on the SAME thread. A guid right for the send and wrong for
   * the indicator is the stuck-"…" bug `presence.ts` exists to prevent.
   */
  async resolveChatGuid(handle: string): Promise<string> {
    const now = this.now();
    const cached = this.guidCache.get(handle);
    if (
      cached &&
      now - cached.at < (cached.hit ? BlueBubblesClient.GUID_TTL_MS : BlueBubblesClient.GUID_MISS_TTL_MS)
    ) {
      return cached.guid;
    }
    let guid: string | null = null;
    try {
      guid = await this.queryChatGuid(handle);
    } catch {
      guid = null;
    }
    if (guid) {
      this.guidCache.set(handle, { guid, at: now, hit: true });
      return guid;
    }
    const canonicalFallback = canonicalPhone(handle);
    const fallback = chatGuidFor(canonicalFallback ?? handle);
    this.guidCache.set(handle, { guid: fallback, at: now, hit: false });
    return fallback;
  }

  /** A resolved guid is good for 30 min: threads do not move, and the chat list is the expensive part. */
  private static readonly GUID_TTL_MS = 30 * 60_000;

  /** A miss (fallback in use) is re-checked after 5 min, in case the thread appears. */
  private static readonly GUID_MISS_TTL_MS = 5 * 60_000;

  /** Hard page cap for the walk, against a misbehaving `metadata.total`. */
  private static readonly GUID_MAX_PAGES = 10;

  /**
   * Walk the server's chat list for the thread with `handle`.
   *
   * `POST /chat/query` is the only route that lists chats (measured 2026-09-17:
   * `GET /chat` is a 404; the route lives in the shipped `app.asar`). The
   * `where` participant filter it accepts is IGNORED by the server, so the
   * filtering happens here, on the rows. An exact `chatIdentifier` match wins
   * over a participant-address match: in the 1:1 threads this bot addresses the
   * two agree, and a participant-only match is the shape of a GROUP, which this
   * bot does not address (see `chatGuidFor`).
   *
   * Throws on a refused request so the caller can treat it like any transport
   * failure; returns `null` when the list was read but no thread matched.
   */
  private async queryChatGuid(handle: string): Promise<string | null> {
    // The forms the server may have stored for this same person: the raw
    // string, plus its E.164 spelling. BlueBubbles writes `+1XXXXXXXXXX`
    // while a message types `(801) 555-4271` — both must find one thread.
    const canonical = canonicalPhone(handle);
    const forms = canonical ? [handle, canonical] : [handle];
    let participantMatch: string | null = null;
    let offset = 0;
    for (let page = 0; page < BlueBubblesClient.GUID_MAX_PAGES; page += 1) {
      const { status, body } = await this.call('/chat/query', {
        method: 'POST',
        body: JSON.stringify({ limit: PAGE_SIZE, offset }),
      });
      if (status >= 400) throw new Error(`chat/query refused (http ${status})`);
      const rows = BlueBubblesClient.data(body);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows as Record<string, unknown>[]) {
        const guid = typeof r['guid'] === 'string' ? r['guid'] : '';
        if (!guid) continue;
        if (BlueBubblesClient.identifierMatches(r['chatIdentifier'], forms)) return guid;
        if (participantMatch === null && BlueBubblesClient.chatHasParticipant(r, forms)) {
          participantMatch = guid;
        }
      }
      const total = Number(
        (body as { metadata?: { total?: unknown } } | null)?.metadata?.['total'] ?? NaN,
      );
      offset += rows.length;
      // Stop when the server says it has no more. A missing/NaN total stops
      // after the first page: an unreadable bound is "do not know", and the
      // miss-fallback then behaves exactly like the old code.
      if (rows.length < PAGE_SIZE || !Number.isFinite(total) || offset >= total) break;
    }
    return participantMatch;
  }

  /** `participants` is a list of `{ address, service, … }` objects on 1.9.9, not strings. */
  private static chatHasParticipant(row: Record<string, unknown>, forms: string[]): boolean {
    const ps = row['participants'];
    if (!Array.isArray(ps)) return false;
    return ps.some(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        forms.includes((p as { address?: unknown })['address'] as string),
    );
  }

  /** Exact-or-canonical: the thread's `chatIdentifier` matches any of `forms`. */
  private static identifierMatches(identifier: unknown, forms: string[]): boolean {
    return typeof identifier === 'string' && forms.includes(identifier);
  }

  /**
   * Send text, optionally ANCHORED to a message it is replying to.
   *
   * 🔴 A 200 means "no error code at send time". It is NOT delivery. A real
   * verdict needs `deliveryVerdict(guid)`, and BlueBubbles reports a genuine
   * red-bubble failure as **HTTP 500 "Message sent with an error"** with a
   * written-but-undelivered row carrying `error: 22`.
   *
   * ── `replyToGuid` — MEASURED 2026-08-26 AGAINST THIS SERVER (1.9.9) ────────
   *
   * `selectedMessageGuid` + `partIndex` are the wire names, read out of the
   * shipped `app.asar` (`messageValidator.sendTextRules`) and then exercised
   * live. Two things about it are NOT guessable from the parameter names:
   *
   * 1. **It silently switches the send to the Private API.** BlueBubbles' own
   *    validator does `if (effectId || subject || selectedMessageGuid || …)
   *    saniMethod = "private-api"`, so a reply-anchored send goes down a wholly
   *    different path from a plain one — one that needs the helper bundle
   *    connected. `helper_connected` was **false** as recently as 2026-08-24, in
   *    which case this route 500s and a plain send still works. That is why the
   *    caller must be able to fall back, and why threading is never load-bearing.
   *
   * 2. 🔴 **A reply target BlueBubbles cannot find costs 120 SECONDS, not an
   *    error.** Measured: an unknown `selectedMessageGuid` stalls for exactly
   *    120s and then returns `500 {"error":{"message":"Transaction timeout"}}`.
   *    The cause is in `MessageInterface.sendMessagePrivateApi`: it polls the
   *    iMessage DB (`resultAwaiter`, `maxWaitMs: 60000`, exponential backoff
   *    that overshoots) for a message that is never written. **Nothing is sent.**
   *    A plain send with the same body fails fast or succeeds fast.
   *
   * So an anchored send gets its own, longer timeout. It is still far below the
   * server's 120s wall — the point is not to wait it out, it is that aborting at
   * the ordinary 15s would make every slow-but-fine reply look like a failure.
   */
  async sendText(to: string, text: string, replyToGuid?: string | null): Promise<SendResult> {
    const anchored = typeof replyToGuid === 'string' && replyToGuid.length > 0;
    const chatGuid = await this.resolveChatGuid(to);
    const { status, body } = await this.call(
      '/message/text',
      {
        method: 'POST',
        body: JSON.stringify({
          chatGuid,
          message: stripMarkdown(text),
          tempGuid: `jedd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...(anchored ? { selectedMessageGuid: replyToGuid, partIndex: 0 } : {}),
        }),
      },
      anchored
        ? BlueBubblesClient.ANCHORED_SEND_TIMEOUT_MS
        : BlueBubblesClient.PLAIN_SEND_TIMEOUT_MS,
    );
    if (status >= 400) {
      return {
        accepted: false,
        guid: null,
        delivery: 'failed',
        detail:
          `BlueBubbles refused the send (http ${status})` +
          `${anchored ? ' — this one was anchored to a reply target, which routes it through the Private API' : ''}` +
          '. This is a delivery failure that has ALREADY happened, not a pending state.',
      };
    }
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    const guid = typeof d?.['guid'] === 'string' ? d['guid'] : null;
    return {
      accepted: true,
      guid,
      delivery: 'unknown',
      detail: 'accepted with no error code at send time — this is NOT a delivery confirmation',
    };
  }

  /**
   * One JPEG, via the normal attachment route. `method` is apple-script so this
   * does not require the private-API helper. A failure is a false result, not a
   * thrown error: the text list is still the thing the person confirms.
   */
  async sendAttachment(to: string, filename: string, bytes: Buffer): Promise<SendResult> {
    try {
      const chatGuid = await this.resolveChatGuid(to);
      const form = new FormData();
      form.append('chatGuid', chatGuid);
      form.append('tempGuid', `jedd-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      form.append('name', filename);
      form.append('method', 'apple-script');
      form.append('attachment', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), filename);
      const res = await this.fetchImpl(this.url('/message/attachment'), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(BlueBubblesClient.PLAIN_SEND_TIMEOUT_MS),
      });
      if (res.status >= 400) {
        return {
          accepted: false,
          guid: null,
          delivery: 'failed',
          detail: `BlueBubbles refused the attachment (http ${res.status}).`,
        };
      }
      return {
        accepted: true,
        guid: null,
        delivery: 'unknown',
        detail: 'attachment accepted with no error code — this is NOT a delivery confirmation',
      };
    } catch {
      return {
        accepted: false,
        guid: null,
        delivery: 'failed',
        detail: 'BlueBubbles attachment request failed before a response.',
      };
    }
  }

  /**
   * ⚠️ Long, and deliberately not `this.timeoutMs`. An anchored send is a
   * Private API send: it waits for the message to appear in the iMessage
   * database before answering, so it is legitimately slower than the AppleScript
   * path. See `sendText` for the 120s failure wall this sits under.
   */
  private static readonly ANCHORED_SEND_TIMEOUT_MS = 30_000;

  /**
   * 🔴 PLAIN SENDS GET THEIR OWN TIMEOUT TOO, AND THE 15s DEFAULT IS THE DEFECT.
   *
   * Measured 2026-09-16 against this server: a plain send delivered over the
   * AppleScript fallback can take ~120s to land — the same wall the anchored
   * 120s `Transaction timeout` sits under — and the client's default 15s abort
   * fired in the MIDDLE of it. The send completed on the server and answered 500
   * on the way back, so the turn threw, `main.ts`'s catch sent a failure notice,
   * and Jeff read his reply FOLLOWED by "Something went wrong on my end".
   *
   * 150s clears the 120s wall with margin. The cost of waiting is one slow turn;
   * the cost of aborting early is a false apology to a real person — and the
   * look-back `verifyDelivery` added for exactly that case needs the window
   * between the abort and the read to be small, so it gets it.
   */
  private static readonly PLAIN_SEND_TIMEOUT_MS = 150_000;

  /**
   * DID THIS EXACT TEXT ALREADY GO OUT TO THIS PERSON JUST NOW?
   *
   * 🔴 THIS EXISTS SO THAT A RETRY CANNOT DOUBLE-TEXT SOMEBODY.
   *
   * An anchored send that fails is retried plain (`BlueBubblesConnector.send`),
   * and the whole risk of that retry is the one case where the first send
   * actually worked and only our *answer* was lost — an abort on our side, a
   * dropped socket. The measured failure (`Transaction timeout`) writes nothing,
   * so a retry there is safe; but "the failure I measured is safe" is not the
   * same claim as "every failure is safe", and the difference is a duplicate
   * message on a real person's phone.
   *
   * So the retry asks BlueBubbles' own database first. Three states, and the
   * middle one is the important one:
   *
   *   `true`  — it is there. Do NOT resend.
   *   `false` — we read the recent history and it is not there. Resending is safe.
   *   `null`  — 🔴 we could not read it. **This is not `false`.** The caller must
   *             not resend on it; an unread history is exactly when a duplicate
   *             is most likely to be the thing we cannot see.
   */
  async recentlySent(to: string, text: string, withinMs = 180_000): Promise<boolean | null> {
    const wanted = stripMarkdown(text).trim();
    try {
      const { status, body } = await this.call('/message/query', {
        method: 'POST',
        body: JSON.stringify({
          limit: 25,
          offset: 0,
          sort: 'DESC',
          with: ['chat'],
          // Same resolved guid as the send itself: a look-back that queries the
          // constructed form reads a thread the send never wrote and says "not
          // there", so a retry double-texts.
          chatGuid: await this.resolveChatGuid(to),
        }),
      });
      if (status >= 400) return null;
      const rows = BlueBubblesClient.data(body);
      if (!Array.isArray(rows)) return null;
      const floor = Date.now() - withinMs;
      for (const r of rows as Record<string, unknown>[]) {
        if (r['isFromMe'] !== true) continue;
        const when = Number(r['dateCreated']);
        if (Number.isFinite(when) && when > 0 && when < floor) continue;
        if (typeof r['text'] === 'string' && r['text'].trim() === wanted) return true;
      }
      return false;
    } catch {
      // A transport failure is UNKNOWN. Saying `false` here would turn "I could
      // not check" into "it definitely did not send", which is how you get two.
      return null;
    }
  }

  /**
   * ── PRIVATE API SURFACE: typing indicators and read receipts ───────────────
   *
   * 🔴 THESE DELIBERATELY DO NOT SWALLOW THEIR OWN FAILURES.
   *
   * They are the only calls in this file whose whole point is that they must
   * never break a reply — so the temptation is to make them un-throwable right
   * here. That would be a mistake, because the swallow belongs in exactly one
   * place (`Presence`) and a subject that cannot throw cannot be used to prove
   * that its caller survives a throw. A test that stubs `fetch` to reject and
   * asserts the turn still completes only means something while these can
   * genuinely propagate. So an HTTP error comes back as a RESULT and a transport
   * failure comes back as a THROW, the same as every other method here.
   *
   * ⚠️ The timeout is short and separate from `this.timeoutMs`. A presence
   * signal that is 5 seconds late is worthless even if it succeeds, and holding
   * a request open for 15s to deliver one is 15s of an open socket bought for
   * nothing.
   */
  private static readonly PRESENCE_TIMEOUT_MS = 5_000;

  private async presenceCall(path: string, method: 'POST' | 'DELETE'): Promise<PrivateApiResult> {
    const { status, body } = await this.call(path, { method }, BlueBubblesClient.PRESENCE_TIMEOUT_MS);
    const b = body as { message?: unknown; error?: { message?: unknown } } | null;
    const inner = typeof b?.error?.message === 'string' ? b.error.message : '';
    const outer = typeof b?.message === 'string' ? b.message : '';
    // Match on the helper's own wording. `restrictedPrivateApi` throws with the
    // outer sentence and carries the inner one from `checkPrivateApiStatus()`;
    // both are checked because only one of them names the *helper* specifically
    // and the other also fires when the setting itself is off.
    const helperAbsent =
      status >= 400 && /helper is not connected|your helper is connected/i.test(`${inner} ${outer}`);
    return {
      ok: status >= 200 && status < 300,
      status,
      helperAbsent,
      detail: helperAbsent
        ? `Private API helper is not connected (http ${status}). Expected until SIP is disabled and the ` +
          'BlueBubbles helper bundle is installed — this is not a fault and nothing was lost but a nicety.'
        : status >= 400
          ? `http ${status}: ${outer || inner || 'no message'}`
          : `http ${status}`,
    };
  }

  /**
   * Show "…" in the recipient's thread.
   *
   * 🔴 IT DOES NOT STOP BY ITSELF ON OUR SIDE. The helper calls Apple's
   * `-[IMChat setLocalUserIsTyping:]` (confirmed in the shipped
   * `BlueBubblesHelper.dylib`), and neither BlueBubbles nor the helper holds any
   * expiry timer — BlueBubbles only tracks a `typingCache` array so it can stop
   * on send. Whatever hides the indicator afterwards is Apple's, on the
   * RECIPIENT'S device, and is not a number this codebase can see. So the stop
   * is ours to guarantee: see `Presence`.
   *
   * 🔴 START STAYS ON THIS HTTP ROUTE ON PURPOSE, EVEN THOUGH ITS PARTNER DOES
   * NOT — because `ChatInterface.startTyping` is the ONLY thing in BlueBubbles
   * that pushes the guid into `Server().typingCache`, and that cache is the sole
   * trigger for BlueBubbles' own stop-on-send. Moving start onto the socket
   * (`started-typing` → `ActionHandler.startOrStopTypingInChat`, which never
   * touches the cache) would look tidier, work in a demo, and silently delete
   * the last independent stop this design has. See `stopTyping` below.
   */
  async startTyping(chatGuid: string): Promise<PrivateApiResult> {
    return this.presenceCall(`/chat/${encodeURIComponent(chatGuid)}/typing`, 'POST');
  }

  /**
   * Hide the "…". Must always run — see `Presence.withTyping`.
   *
   * ── 🔴 THIS DOES NOT USE `DELETE /chat/{guid}/typing`. THAT ROUTE STARTS ────
   * ── TYPING. ────────────────────────────────────────────────────────────────
   *
   * Measured in the shipped bundle on 2026-08-25, BlueBubbles server 1.9.9
   * (`app.asar` → `dist/main.js`, i.e. the code that is actually running, and
   * still present on upstream `master` the same day):
   *
   * ```js
   * static async stopTyping(e,t){const{guid:a}=e.params;
   *   return await Fu.startTyping(a),                    // Fu = ChatInterface
   *     new Rh(e,{message:"Successfully stopped typing!"}).send()}
   * ```
   *
   * The DELETE controller calls `startTyping` and answers **HTTP 200
   * "Successfully stopped typing!"**. So the call reports success, `ok` is true,
   * `Presence.report()` returns early, and NOTHING IS LOGGED — while the
   * indicator is switched back on. That is not a theory: Jeff watched "…"
   * reappear for a beat after every reply, and BlueBubbles' own log shows our
   * DELETE landing 4ms after the message was written.
   *
   * ⚠️ `ChatInterface.stopTyping` exists and is correct. It is simply not
   * reachable from any HTTP route. The ONE reachable path to it is the socket.io
   * event below (`stopped-typing` → `ActionHandler.startOrStopTypingInChat(guid,
   * false)`), confirmed live against `127.0.0.1:1234` by BlueBubbles' own debug
   * log printing `Executing Action: Change Typing Status` for the socket call
   * and nothing at all for the DELETE.
   *
   * 🔴 THIS WORKAROUND IS PERMANENT. IT IS NOT WAITING FOR A RELEASE.
   *
   * The inverted line is on BlueBubbles' `master` as well as in 1.9.9, and the
   * bug was reported to nobody — Jeff was asked and declined, which is his call.
   * So there is no version to upgrade to that fixes this, and **an upgrade could
   * change the socket API out from under us while leaving the DELETE route just
   * as broken.** If the socket path ever stops working, re-measure the DELETE
   * route before assuming it was fixed: `POST` a typing indicator, `DELETE` it,
   * and look for `Executing Action: Change Typing Status` in
   * `~/Library/Logs/bluebubbles-server/main.log`. If that line is absent, the
   * DELETE is still a start.
   *
   * ⚠️ Do NOT "simplify" this back to a one-line DELETE because the verb reads
   * right, and do NOT move `startTyping` onto the socket to match. The
   * asymmetry looks like sloppiness and is load-bearing in both directions: the
   * verb is the trap on this side, and `typingCache` is the reason on the
   * other. Tidying either one silently removes a guarantee.
   */
  async stopTyping(chatGuid: string): Promise<PrivateApiResult> {
    return this.socketEmit('stopped-typing', { chatGuid });
  }

  /**
   * Emit ONE socket.io event and read the server's answer, over the Engine.IO
   * **polling** transport — which is plain HTTP, so it needs no socket.io client
   * and no dependency.
   *
   * ⚠️ A FRESH SESSION PER CALL, DELIBERATELY. A long-lived socket would be a
   * second connection to keep alive, reconnect, and reason about at shutdown,
   * and it would receive every server event as a bonus. This runs about a dozen
   * times a day, off the reply path, entirely over loopback: four small requests
   * are cheaper than a lifecycle. The session is closed explicitly so BlueBubbles
   * does not have to time it out.
   *
   * Returns a RESULT for a protocol or HTTP failure and THROWS for a transport
   * failure, exactly like `presenceCall` — the swallow stays in `Presence`.
   *
   * ⚠️ `helperAbsent` is always false here. `ActionHandler` checks only the
   * `enable_private_api` SETTING and never the helper, so a disconnected helper
   * comes back as a generic error rather than the recognisable 500. That is
   * acceptable because the helper-absent notice is raised by `startTyping`,
   * which runs first on every turn and does go through the middleware.
   */
  private async socketEmit(event: string, payload: unknown): Promise<PrivateApiResult> {
    const q =
      `EIO=4&transport=polling&password=${encodeURIComponent(this.opts.password)}`;
    const at = (sid?: string): string =>
      `${this.opts.baseUrl}/socket.io/?${q}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;
    const fail = (status: number, detail: string): PrivateApiResult => ({
      ok: false,
      status,
      helperAbsent: false,
      detail,
    });

    const get = async (url: string): Promise<{ status: number; text: string }> => {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(BlueBubblesClient.PRESENCE_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    };
    const post = async (url: string, body: string): Promise<{ status: number; text: string }> => {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(BlueBubblesClient.PRESENCE_TIMEOUT_MS),
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
      return { status: res.status, text: await res.text() };
    };

    // 1. Handshake. The reply is an Engine.IO `0` packet carrying the session id.
    const hs = await get(at());
    if (hs.status >= 400) return fail(hs.status, `socket handshake refused (http ${hs.status})`);
    let sid = '';
    try {
      // The whole packet after the leading `0` is the JSON. Do NOT slice to the
      // first `}` — that is correct only while the handshake object stays flat.
      sid = String((JSON.parse(hs.text.slice(hs.text.indexOf('{'))) as { sid?: string })?.sid ?? '');
    } catch {
      sid = '';
    }
    if (!sid) return fail(hs.status, `socket handshake returned no session id: ${hs.text.slice(0, 80)}`);

    try {
      // 2. Join the default namespace, then 3. emit.
      //
      // ⚠️ BOTH STATUSES ARE CHECKED. A rejected join means the emit is dropped
      // server-side, and the stop is genuinely lost — but the symptom surfaces
      // three steps later as "no answer", pointing at the wrong leg.
      const joined = await post(at(sid), '40');
      if (joined.status >= 400) return fail(joined.status, `socket join refused (http ${joined.status})`);
      const sent = await post(at(sid), `42${JSON.stringify([event, payload])}`);
      if (sent.status >= 400) return fail(sent.status, `socket emit refused (http ${sent.status})`);

      /**
       * 4. Read what came back.
       *
       * 🔴 MATCH ON THE CHANNEL, NEVER ON POSITION. This socket joined the
       * default namespace, so BlueBubbles broadcasts every server event to it —
       * and the moment we stop typing is the moment it is dispatching webhooks
       * for the message just sent. Taking the first `42` frame would report a
       * healthy stop as `answered on "new-message"`, once per turn.
       *
       * ⚠️ AND POLL TWICE. Engine.IO flushes whatever is buffered the instant a
       * poll opens, so the first one can return the `40` join ack alone, with
       * the handler's answer still a tick away. One retry is the difference
       * between reporting a stop that worked and reporting a failure.
       */
      let answer: { channel: string; data: { status?: unknown; message?: unknown } } | null = null;
      let last = '';
      let status = 200;
      for (let poll = 0; poll < 2 && !answer; poll += 1) {
        const back = await get(at(sid));
        status = back.status;
        last = back.text;
        for (const packet of back.text.split(SOCKET_IO_RECORD_SEPARATOR)) {
          if (!packet.startsWith('42')) continue;
          try {
            const [c, d] = JSON.parse(packet.slice(2)) as [string, { status?: unknown; message?: unknown }];
            if (c === `${event}-sent` || c === `${event}-error`) {
              answer = { channel: c, data: d ?? {} };
              break;
            }
          } catch {
            // Not ours, or not parseable. Keep looking; the answer may be next.
          }
        }
      }
      if (!answer) return fail(status, `no answer to ${event}: ${last.slice(0, 120)}`);

      const reported = typeof answer.data.status === 'number' ? answer.data.status : status;
      // 🔴 The CHANNEL is the verdict, not the HTTP status. Every polling
      // response is a 200; BlueBubbles reports the outcome by answering on
      // `${event}-sent` or `${event}-error`.
      if (answer.channel !== `${event}-sent`) {
        return fail(
          reported,
          `${event} answered on "${answer.channel}": ${String(answer.data.message ?? 'no message')}`,
        );
      }
      return { ok: true, status: reported, helperAbsent: false, detail: `socket ${answer.channel} (${reported})` };
    } finally {
      // Tell BlueBubbles the session is done rather than leaving it to expire.
      // In a `finally` so it also runs when a step above threw — otherwise the
      // comment promising an explicit close is true only on the happy path.
      await post(at(sid), '41').catch(() => undefined);
    }
  }

  /**
   * Mark the conversation read, so the sender sees "Read" rather than
   * "Delivered".
   *
   * ⚠️ It marks the **CHAT**, not the one message — BlueBubbles' controller
   * forwards `mark-chat-read` with a chat guid and nothing finer. On a 1:1
   * thread that is the same thing in practice, but it means a backlog recovered
   * by replay is marked read wholesale by the first message we act on.
   */
  async markChatRead(chatGuid: string): Promise<PrivateApiResult> {
    return this.presenceCall(`/chat/${encodeURIComponent(chatGuid)}/read`, 'POST');
  }

  /** Three-state delivery verdict for a sent message. `unknown` is not a "no". */
  async deliveryVerdict(guid: string): Promise<DeliveryVerdict> {
    const { status, body } = await this.call(`/message/${encodeURIComponent(guid)}`);
    if (status >= 400) return 'unknown';
    const d = BlueBubblesClient.data(body) as Record<string, unknown> | undefined;
    if (!d) return 'unknown';
    const error = Number(d['error'] ?? 0);
    if (Number.isFinite(error) && error !== 0) return 'failed';
    if (d['isDelivered'] === true) return 'delivered';
    const delivered = Number(d['dateDelivered'] ?? 0);
    if (Number.isFinite(delivered) && delivered > 0) return 'delivered';
    return 'unknown';
  }
}
