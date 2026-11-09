import { createHash } from 'node:crypto';
import { runOnHp, type ExecImpl } from '../hp.js';

/**
 * Read a downloaded file off hp, over the ssh channel we already have.
 *
 * ── WHY BASE64 RATHER THAN scp ───────────────────────────────────────────────
 *
 * base64 contains no character either shell can act on, which is the recorded
 * discipline in this codebase for crossing a machine boundary. And unlike `scp`
 * it creates **no window in which the file exists in two places**, and no
 * cleanup path that will eventually not run.
 *
 * ── 🔴 THE TRANSFER IS VERIFIED, AND THIS IS THE POINT ───────────────────────
 *
 * A truncated read produces a **corrupt epub**, which Amazon rejects as
 * `E001 - Unsupported File Format`. Our own bounce detector would catch that —
 * **and report it as a DELIVERY failure, which is the wrong diagnosis for a
 * TRANSPORT bug.** A wrong diagnosis costs more than a missing one: it sends the
 * next person looking at Amazon, at the file format, at the book — anywhere but
 * at the pipe.
 *
 * So size and sha256 are taken **on hp**, before the bytes move, and checked
 * against the decoded buffer here. A mismatch fails loudly and locally, where it
 * is cheap and unambiguous.
 */

export type FetchOutcome =
  | { state: 'ok'; bytes: Buffer; sha256: string; name: string }
  | { state: 'missing'; detail: string }
  | { state: 'corrupt'; detail: string }
  | { state: 'unknown'; detail: string };

/** Single-quote for the remote shell. Real paths contain spaces. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Refuse anything that is not a plain absolute path before it reaches a shell. */
export function isSafeHostPath(p: string): boolean {
  if (!p.startsWith('/')) return false;
  // Newlines would break the framing of the stat/sha output we parse below.
  if (/[\n\r\0]/.test(p)) return false;
  if (p.includes('/../')) return false;
  return true;
}

/**
 * Preference order for the thing to actually send.
 *
 * 🔴 EXTENSION PREFERENCE, NOT LARGEST-FILE. V1 picked the largest file and sent
 * the wrong book out of a bundle. Measured on the real download: the folder held
 * an `.epub` (2.19 MB), a `.mobi` (793 KB), a cover `.jpg`, an `.opf`, and a junk
 * `pharmakate.txt` — nested one level deeper than `content_path` pointed. Largest
 * happens to be right here and would be wrong for a bundle with a big PDF scan.
 */
const BOOK_EXTENSIONS = ['.epub'] as const;

export type ResolveOutcome =
  | { state: 'ok'; path: string }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * Turn qBittorrent's `content_path` into the path of the file to send.
 *
 * ⚠️ `content_path` is a DIRECTORY for a multi-file torrent, which is the common
 * case for ebooks — they ship with a cover, an `.opf`, sometimes several formats
 * and sometimes a junk text file. So this recurses and CHOOSES, rather than
 * assuming the path names a file.
 */
export async function resolveBookPath(input: {
  adminSshHost: string;
  hostPath: string;
  exec?: ExecImpl;
}): Promise<ResolveOutcome> {
  if (!isSafeHostPath(input.hostPath)) {
    return { state: 'unknown', detail: `refusing to inspect "${input.hostPath}".` };
  }
  const q = shellQuote(input.hostPath);
  // One command answers both questions: is it a file, and if not what is inside.
  const out = await runOnHp(
    input.adminSshHost,
    `if [ -f ${q} ]; then echo "FILE"; elif [ -d ${q} ]; then find ${q} -type f -printf '%s\t%p\n'; else echo "ABSENT"; fi`,
    30_000,
    input.exec,
  );
  if (out.exitCode !== 0) {
    return { state: 'unknown', detail: `could not inspect the path (exit ${out.exitCode}).` };
  }
  const text = out.stdout.trim();
  if (text === 'FILE') {
    if (!input.hostPath.toLowerCase().endsWith('.epub')) {
      return { state: 'none', detail: `"${input.hostPath}" is not an EPUB. Nothing to send.` };
    }
    return { state: 'ok', path: input.hostPath };
  }
  if (text === 'ABSENT' || !text) {
    return {
      state: 'none',
      detail:
        `"${input.hostPath}" is neither a file nor a directory on hp. If the download completed, ` +
        'this is a path problem rather than a missing book.',
    };
  }
  const files = text
    .split('\n')
    .map((line) => {
      const [size, ...rest] = line.split('\t');
      return { size: Number(size), path: rest.join('\t') };
    })
    .filter((f) => Number.isFinite(f.size) && f.path);

  for (const ext of BOOK_EXTENSIONS) {
    const matching = files.filter((f) => f.path.toLowerCase().endsWith(ext));
    if (matching.length === 0) continue;
    // Within ONE format, the largest is the book rather than a sample.
    matching.sort((a, b) => b.size - a.size);
    return { state: 'ok', path: matching[0]!.path };
  }
  return {
    state: 'none',
    detail:
      `"${input.hostPath}" contains ${files.length} file(s) but none is a book ` +
      `(${BOOK_EXTENSIONS.join(', ')}). Nothing to send.`,
  };
}

export async function fetchFileFromHp(input: {
  adminSshHost: string;
  hostPath: string;
  /** Refuse anything larger. An epub is single-digit MB; a mistake is not. */
  maxBytes?: number;
  exec?: ExecImpl;
}): Promise<FetchOutcome> {
  const maxBytes = input.maxBytes ?? 25 * 1024 * 1024;
  if (!isSafeHostPath(input.hostPath)) {
    return { state: 'unknown', detail: `refusing to read "${input.hostPath}": not a plain absolute path.` };
  }
  const q = shellQuote(input.hostPath);

  // Measure BEFORE moving anything, so the comparison is independent of the
  // transfer rather than derived from it.
  const meta = await runOnHp(
    input.adminSshHost,
    `if [ -f ${q} ]; then stat -c %s ${q}; sha256sum ${q} | cut -d' ' -f1; else echo MISSING; fi`,
    30_000,
    input.exec,
  );
  if (meta.exitCode !== 0) {
    return { state: 'unknown', detail: `could not stat the file (exit ${meta.exitCode}).` };
  }
  const lines = meta.stdout.trim().split('\n');
  if (lines[0] === 'MISSING') {
    return {
      state: 'missing',
      detail:
        `"${input.hostPath}" does not exist on hp. If the download completed, this is a PATH ` +
        'problem — qBittorrent reports a path inside its own container — not a missing download.',
    };
  }
  const expectedSize = Number(lines[0]);
  const expectedSha = (lines[1] ?? '').trim();
  if (!Number.isFinite(expectedSize) || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    return { state: 'unknown', detail: `could not read a size and checksum for "${input.hostPath}".` };
  }
  if (expectedSize > maxBytes) {
    return {
      state: 'unknown',
      detail: `"${input.hostPath}" is ${expectedSize} bytes, over the ${maxBytes} limit. Not read.`,
    };
  }
  if (expectedSize === 0) {
    return { state: 'corrupt', detail: `"${input.hostPath}" is zero bytes. There is nothing to send.` };
  }

  // -w0 so the payload is one line and cannot be re-wrapped by anything between.
  const read = await runOnHp(input.adminSshHost, `base64 -w0 ${q}`, 120_000, input.exec);
  if (read.exitCode !== 0) {
    return { state: 'unknown', detail: `could not read the file (exit ${read.exitCode}).` };
  }
  const bytes = Buffer.from(read.stdout.trim(), 'base64');

  if (bytes.length !== expectedSize) {
    return {
      state: 'corrupt',
      detail:
        `TRANSFER TRUNCATED: expected ${expectedSize} bytes, decoded ${bytes.length}. Nothing was ` +
        'sent. This is a transport fault, NOT a problem with the book or with Amazon.',
    };
  }
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== expectedSha) {
    return {
      state: 'corrupt',
      detail:
        `TRANSFER CORRUPT: checksum on hp was ${expectedSha.slice(0, 12)}…, decoded here as ` +
        `${actualSha.slice(0, 12)}…. Nothing was sent. This is a transport fault.`,
    };
  }
  return {
    state: 'ok',
    bytes,
    sha256: actualSha,
    name: input.hostPath.split('/').pop() ?? 'document',
  };
}
