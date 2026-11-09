/**
 * Read one finished ebook out of the SABnzbd category directory.
 *
 * SABnzbd reports `storage` as a path inside ITS container. This process sees
 * that same folder only where it was bind-mounted. The translation is a prefix
 * swap plus a realpath containment check, so a `..`, a prefix trick, or a
 * symlink that leaves the mount is not a file we will open.
 *
 * The mount is expected to be read-only. Nothing here writes.
 */

import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

/** Same ceiling `fetchFileFromHp` uses. An epub is a few megabytes. */
export const MAX_EBOOK_BYTES = 25 * 1024 * 1024;

const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 400;

/** Only an EPUB is mailed. Other files in the same folder are ignored. */
const BOOK_EXTENSIONS = ['.epub'] as const;

export type LocatedBook =
  | { state: 'ok'; filename: string; bytes: Buffer }
  | { state: 'absent'; detail: string }
  | { state: 'rejected'; detail: string }
  | { state: 'unknown'; detail: string };

function normaliseAbsolute(p: string): string | null {
  if (!isAbsolute(p) || /[\0\r\n]/.test(p)) return null;
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0 || segs.includes('..') || segs.includes('.')) return null;
  return `/${segs.join('/')}`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Map a SABnzbd `storage` path onto the local mount. String checks only — the
 * caller still has to realpath the result before reading.
 *
 * Both prefixes are required configuration. There is no built-in folder.
 */
export function localPathForStorage(
  storage: string,
  storagePrefix: string,
  localDir: string,
): { ok: true; path: string } | { ok: false; detail: string } {
  const storagePath = normaliseAbsolute(storage);
  const prefix = normaliseAbsolute(storagePrefix);
  const local = normaliseAbsolute(localDir);
  if (!storagePath) return { ok: false, detail: 'SABnzbd storage path is not a plain absolute path.' };
  if (!prefix) return { ok: false, detail: 'SABNZBD_STORAGE_PREFIX is not a plain absolute path.' };
  if (!local) return { ok: false, detail: 'SABNZBD_LOCAL_DIR is not set to a plain absolute path.' };
  if (storagePath !== prefix && !storagePath.startsWith(`${prefix}/`)) {
    return {
      ok: false,
      detail: `SABnzbd reported "${storagePath}", which is outside the configured ebook folder "${prefix}".`,
    };
  }
  const rest = storagePath.slice(prefix.length);
  return { ok: true, path: `${local}${rest}` };
}

interface Candidate {
  path: string;
  ext: (typeof BOOK_EXTENSIONS)[number];
  size: number;
}

/**
 * Find the book under `storage` and return its bytes.
 *
 * Symlinks are opened only when their real path is still inside the mount.
 * The open itself uses `O_NOFOLLOW` on that real path, which is a regular file.
 */
export async function readContainedBook(input: {
  storage: string;
  storagePrefix: string;
  localDir: string;
  maxBytes?: number;
}): Promise<LocatedBook> {
  const maxBytes = input.maxBytes ?? MAX_EBOOK_BYTES;
  const mapped = localPathForStorage(input.storage, input.storagePrefix, input.localDir);
  if (!mapped.ok) return { state: 'rejected', detail: mapped.detail };

  let rootReal: string;
  try {
    rootReal = await realpath(normaliseAbsolute(input.localDir)!);
  } catch {
    return {
      state: 'unknown',
      detail: `the ebook folder "${input.localDir}" is not readable. Is the read-only mount present?`,
    };
  }

  const found: Candidate[] = [];
  const budget = { n: 0, oversized: 0 };
  const walked = await walk(mapped.path, rootReal, 0, found, budget, maxBytes);
  if (walked) return walked;
  if (found.length === 0 && budget.oversized > 0) {
    return {
      state: 'rejected',
      detail: `the completed book is over the ${maxBytes} byte limit. Not read.`,
    };
  }
  if (found.length === 0) {
    return {
      state: 'absent',
      detail:
        'the completed folder has no .epub. It is not an EPUB. An NZB, a PDF, an audiobook, or an empty unpack was not mailed.',
    };
  }
  found.sort((a, b) => BOOK_EXTENSIONS.indexOf(a.ext) - BOOK_EXTENSIONS.indexOf(b.ext) || b.size - a.size);
  const best = found[0]!;
  if (best.size > maxBytes) {
    return {
      state: 'rejected',
      detail: `"${best.path.split('/').pop()}" is ${best.size} bytes, over the ${maxBytes} limit. Not read.`,
    };
  }
  return readRegularFile(best.path, rootReal, maxBytes);
}

async function walk(
  path: string,
  rootReal: string,
  depth: number,
  found: Candidate[],
  budget: { n: number; oversized: number },
  maxBytes: number,
): Promise<LocatedBook | null> {
  if (budget.n++ > MAX_WALK_ENTRIES) {
    return { state: 'rejected', detail: 'the completed folder has too many entries to scan. Nothing was read.' };
  }
  if (depth > MAX_WALK_DEPTH) return null;
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return depth === 0
      ? { state: 'absent', detail: 'the completed path is not on the ebook mount yet.' }
      : null;
  }
  if (!isInside(rootReal, real)) {
    if (depth === 0) {
      return {
        state: 'rejected',
        detail: 'that path resolves outside the ebook folder (symlink or prefix escape). Nothing was read.',
      };
    }
    return null;
  }
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return depth === 0 ? { state: 'unknown', detail: 'could not open the completed path.' } : null;
  }
  try {
    const st = await fh.stat();
    if (st.isFile()) {
      consider(real, st.size, found, budget, maxBytes);
      return null;
    }
    if (!st.isDirectory()) return null;
  } finally {
    await fh.close();
  }
  let names: string[];
  try {
    names = await readdir(real);
  } catch {
    return { state: 'unknown', detail: 'could not list the completed folder.' };
  }
  for (const name of names) {
    if (!name || name.includes('/') || name.includes('\0') || name === '.' || name === '..') continue;
    const stop = await walk(`${real}/${name}`, rootReal, depth + 1, found, budget, maxBytes);
    if (stop && (stop.state === 'rejected' || stop.state === 'unknown')) return stop;
  }
  return null;
}

function consider(
  path: string,
  size: number,
  found: Candidate[],
  budget: { oversized: number },
  maxBytes: number,
): void {
  const lower = path.toLowerCase();
  const ext = BOOK_EXTENSIONS.find((e) => lower.endsWith(e));
  if (!ext || size <= 0) return;
  if (size > maxBytes) {
    budget.oversized += 1;
    return;
  }
  found.push({ path, ext, size });
}

async function readRegularFile(path: string, rootReal: string, maxBytes: number): Promise<LocatedBook> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { state: 'absent', detail: 'the book file disappeared before it could be read.' };
  }
  if (!isInside(rootReal, real)) {
    return { state: 'rejected', detail: 'the book file resolves outside the ebook folder. Nothing was read.' };
  }
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { state: 'unknown', detail: 'could not open the book file.' };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      return { state: 'rejected', detail: 'the book path is not a regular file. Nothing was read.' };
    }
    if (st.size > maxBytes) {
      return { state: 'rejected', detail: `the book is ${st.size} bytes, over the ${maxBytes} limit. Not read.` };
    }
    const bytes = await fh.readFile();
    if (bytes.length !== st.size) {
      return { state: 'unknown', detail: 'the book changed length while it was being read. Nothing was sent.' };
    }
    return { state: 'ok', filename: real.split('/').pop() ?? 'book', bytes };
  } finally {
    await fh.close();
  }
}
