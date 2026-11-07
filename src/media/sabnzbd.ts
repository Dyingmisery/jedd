/**
 * SABnzbd's documented HTTP API — just enough to queue an NZB and ask what
 * happened to that one job.
 *
 * The api key travels as the `apikey` query parameter because that is how
 * SABnzbd authenticates. It must never be copied into a tool result, a log
 * line, or a follow-up note. Errors are redacted before they leave this file.
 */

import { redactUrlSecrets } from '../errors.js';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface SabnzbdOptions {
  /** Server root, with no `/api` suffix. Example shape only: the deploy sets this. */
  baseUrl: string;
  apiKey: string;
  /** SABnzbd category name. Not a path. */
  category: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export type SabAdd =
  | { state: 'accepted'; nzoId: string }
  | { state: 'rejected'; detail: string }
  | { state: 'unknown'; detail: string };

export type SabJob =
  | { state: 'queued'; status: string }
  | { state: 'completed'; storage: string }
  | { state: 'failed'; detail: string }
  /** Completed was reported without a storage path. That is not a finished download. */
  | { state: 'incomplete'; detail: string }
  | { state: 'missing'; detail: string }
  | { state: 'unknown'; detail: string };

/** SABnzbd job ids are a single token. Anything else must not reach a URL. */
const NZO_ID = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * Category names we will not submit under. `*` is SABnzbd's default bucket.
 * `readarr` is the usual name of another app's book category; a job filed
 * there is imported by that app instead of staying in this one.
 */
const REFUSED_CATEGORIES = new Set(['readarr', '*']);

export function isValidNzoId(id: string): boolean {
  return NZO_ID.test(id);
}

function refusedCategory(category: string): string | null {
  const name = category.trim().toLowerCase();
  if (!name || REFUSED_CATEGORIES.has(name)) {
    return `refusing SABnzbd category "${category.trim() || '(empty)'}". Use the dedicated ebook category.`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(category.trim())) {
    return `refusing SABnzbd category "${category.trim()}": it is not a plain category name.`;
  }
  return null;
}

function apiUrl(baseUrl: string, apiKey: string, params: Record<string, string>): string {
  const root = baseUrl.trim().replace(/\/+$/, '');
  const url = new URL(`${root}/api`);
  url.searchParams.set('output', 'json');
  url.searchParams.set('apikey', apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function scrub(text: string): string {
  return redactUrlSecrets(text)
    .replace(/\b((?:api_?)?key|token|password|passkey)=[^\s&"']+/gi, '$1=REDACTED')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

async function readJson(
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<{ state: 'ok'; body: unknown } | { state: 'unknown'; detail: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { state: 'unknown', detail: `could not reach SABnzbd (${scrub((e as Error).message)}).` };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { state: 'unknown', detail: `SABnzbd returned http ${res.status}${text ? `: ${scrub(text)}` : ''}.` };
  }
  try {
    return { state: 'ok', body: JSON.parse(text) as unknown };
  } catch {
    return { state: 'unknown', detail: 'SABnzbd returned a body that is not JSON.' };
  }
}

function nzoFrom(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const rec = body as Record<string, unknown>;
  const many = rec['nzo_ids'];
  if (Array.isArray(many) && typeof many[0] === 'string') return many[0];
  return typeof rec['nzo_id'] === 'string' ? rec['nzo_id'] : '';
}

export class SabnzbdClient {
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SabnzbdOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Queue one NZB URL. The returned `nzo_id` is the only handle later polls use.
   * A second call is a second download, so callers must persist the id before
   * they consider retrying.
   */
  async addUrl(nzbUrl: string): Promise<SabAdd> {
    const category = this.opts.category.trim();
    const refused = refusedCategory(category);
    if (refused) return { state: 'rejected', detail: refused };
    let parsed: URL;
    try {
      parsed = new URL(nzbUrl);
    } catch {
      return { state: 'rejected', detail: 'the NZB link is not a URL. Nothing was submitted.' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { state: 'rejected', detail: 'the NZB link is not http(s). Nothing was submitted.' };
    }
    if (!this.opts.baseUrl.trim() || !this.opts.apiKey.trim()) {
      return { state: 'rejected', detail: 'SABnzbd is not configured. Nothing was submitted.' };
    }

    const url = apiUrl(this.opts.baseUrl, this.opts.apiKey, { mode: 'addurl' });
    const body = new URLSearchParams({ name: nzbUrl, cat: category });
    const got = await readJson(this.fetchImpl, url, this.timeoutMs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (got.state !== 'ok') return got;
    const rec = got.body && typeof got.body === 'object' ? (got.body as Record<string, unknown>) : {};
    if (rec['status'] === false) {
      const why = typeof rec['error'] === 'string' ? scrub(rec['error']) : 'SABnzbd refused the NZB.';
      return { state: 'rejected', detail: why };
    }
    const nzoId = nzoFrom(got.body);
    if (!isValidNzoId(nzoId)) {
      return {
        state: 'unknown',
        detail: 'SABnzbd did not return a job id, so the download was not recorded. Nothing will be mailed.',
      };
    }
    return { state: 'accepted', nzoId };
  }

  /**
   * Where this one job is. Queue means still running. History counts only when
   * the same id is `Completed` AND `storage` is a non-empty path. Absence from
   * both is `missing` — not success and not a reason to submit the NZB again.
   */
  async job(nzoId: string): Promise<SabJob> {
    if (!isValidNzoId(nzoId)) {
      return { state: 'unknown', detail: 'that job id cannot be queried.' };
    }
    if (!this.opts.baseUrl.trim() || !this.opts.apiKey.trim()) {
      return { state: 'unknown', detail: 'SABnzbd is not configured.' };
    }

    const queued = await this.slots('queue', 'queue', { mode: 'queue' });
    if (queued.state !== 'ok') return queued;
    const inQueue = queued.slots.find((s) => s.nzoId === nzoId);
    if (inQueue) {
      if (/fail/i.test(inQueue.status)) {
        return { state: 'failed', detail: inQueue.failMessage || `SABnzbd queue status is ${inQueue.status}.` };
      }
      return { state: 'queued', status: inQueue.status || 'Queued' };
    }

    // History is not filtered by category. A job SAB filed somewhere else is
    // still this nzo id; the storage-prefix check is what refuses the wrong folder.
    const past = await this.slots('history', 'history', {
      mode: 'history',
      limit: '200',
      nzo_ids: nzoId,
    });
    if (past.state !== 'ok') return past;
    const done = past.slots.find((s) => s.nzoId === nzoId);
    if (!done) {
      return {
        state: 'missing',
        detail: `SABnzbd has no job ${nzoId} in the queue or in recent history. It may still be registering, or it was removed. Nothing was resubmitted.`,
      };
    }
    if (/^completed$/i.test(done.status)) {
      if (!done.storage) {
        return {
          state: 'incomplete',
          detail: 'SABnzbd marked the job Completed but reported no storage path. The file has not been located.',
        };
      }
      return { state: 'completed', storage: done.storage };
    }
    if (/fail|abort/i.test(done.status) || done.failMessage) {
      return {
        state: 'failed',
        detail: done.failMessage || `SABnzbd history status is ${done.status || 'Failed'}.`,
      };
    }
    return { state: 'queued', status: done.status || 'Processing' };
  }

  private async slots(
    modeName: string,
    key: string,
    params: Record<string, string>,
  ): Promise<{ state: 'ok'; slots: Slot[] } | { state: 'unknown'; detail: string }> {
    const url = apiUrl(this.opts.baseUrl, this.opts.apiKey, params);
    const got = await readJson(this.fetchImpl, url, this.timeoutMs);
    if (got.state !== 'ok') return got;
    const root = got.body && typeof got.body === 'object' ? (got.body as Record<string, unknown>)[key] : undefined;
    const rawSlots =
      root && typeof root === 'object' ? (root as Record<string, unknown>)['slots'] : undefined;
    if (!Array.isArray(rawSlots)) {
      return { state: 'unknown', detail: `SABnzbd ${modeName} response had no slots array.` };
    }
    const slots: Slot[] = [];
    for (const raw of rawSlots) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const nzoId = typeof rec['nzo_id'] === 'string' ? rec['nzo_id'] : '';
      if (!nzoId) continue;
      slots.push({
        nzoId,
        status: typeof rec['status'] === 'string' ? rec['status'] : '',
        storage: typeof rec['storage'] === 'string' ? rec['storage'].trim() : '',
        failMessage: typeof rec['fail_message'] === 'string' ? scrub(rec['fail_message']) : '',
      });
    }
    return { state: 'ok', slots };
  }
}

interface Slot {
  nzoId: string;
  status: string;
  storage: string;
  failMessage: string;
}
