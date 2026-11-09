/**
 * Is this actually a book, and one Amazon will actually accept?
 *
 * ── 🔴 WHY THIS EXISTS, AND WHY IT IS NOT AN IRC FEATURE ─────────────────────
 *
 * The IRC source made this urgent. It did not make it necessary — **the hole was
 * already open on the path that ships today.** `resolveBookPath()` picks a file
 * by **filename suffix** (`fetch-file.ts`), and `sendToKindle()` attaches it with
 * no declared content type. Nothing anywhere reads a single byte of the file to
 * ask what it is. A renamed `.exe` from a torrent is attached and mailed.
 *
 * That is not hypothetical. A "1080p HEVC" TV release grabbed on 2026-08-26 was
 * a **962 MB `.exe` with no video in it**, relabelled weekly to dodge a
 * blocklist. Bots on IRC are exactly as untrusted as an indexer, and neither is
 * more trustworthy than the other. So this sits in front of `sendToKindle` and
 * **both sources go through it** — it is not bolted onto the new leg.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * **Unknown fails toward NOT SENDING.** Anything not positively identified as a
 * book is refused and REPORTED — never forwarded, never silently dropped. The
 * caller is told what the bytes actually looked like, because "we threw your
 * book away" with no reason is its own failure.
 */

/** The only format this pipeline mails. Other Kindle formats are not converted. */
export type EbookFormat = 'epub';

const NON_EPUB_EXT =
  /\.(?:mobi|azw3?|pdf|cbz|cbr|cbt|cb7|mp3|m4b|m4a|flac|ogg|aac|zip|rar|7z|exe|djvu|fb2|lit|prc|txt|html?|docx?|rtf)\b/i;

/**
 * Does this release name claim to be an EPUB, and not some other container?
 * A `.epub.rar` is an archive. A bare "EPUB" token counts; a missing claim does not.
 */
export function isEpubClaim(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/\.(?:rar|zip|7z)\b/i.test(n)) return false;
  if (NON_EPUB_EXT.test(n) && !/\.epub\b/i.test(n)) return false;
  if (/\.epub\b/i.test(n) || /\bepub\b/i.test(n)) return true;
  // No format was named. That is not evidence of a PDF, AZW3, or audiobook.
  return !/\.[a-z0-9]{2,5}\b/i.test(n);
}

export type EbookVerdict =
  | { state: 'ok'; format: EbookFormat; detail: string }
  | { state: 'rejected'; detail: string };

/**
 * 🔴 `.mobi` IS DEAD AND MUST BE REFUSED, NOT ATTACHED.
 *
 * Amazon stopped accepting it in 2022 and answers `E001`. The failure is
 * **invisible from here**: the SMTP transaction succeeds, and the rejection
 * arrives by email to the *sending* account minutes later, where Jedd cannot see
 * it. So attaching a `.mobi` means telling someone their book is on the way and
 * being wrong, with nothing anywhere learning otherwise.
 *
 * **Declining is strictly better than a silent bounce**, which is the whole
 * reason this is a refusal and not a best-effort attach.
 */
const DEAD_FORMAT_NOTE =
  'Amazon stopped accepting .mobi files in 2022 and rejects them silently — the send would ' +
  'look fine from here and the book would never arrive.';

const EPUB_MIMETYPE = 'application/epub+zip';

/**
 * Identify a book from its BYTES, using its filename only to say which format it
 * claims to be. The bytes are the authority; the name is the claim being tested.
 */
export function validateEbookBytes(filename: string, bytes: Buffer): EbookVerdict {
  const name = filename.trim();
  const lower = name.toLowerCase();

  if (bytes.length === 0) {
    return { state: 'rejected', detail: `"${name}" is zero bytes, so it is not a book.` };
  }

  // The dead-format check is on the NAME on purpose: a MOBI and an AZW3 share a
  // container signature (see below), so the extension is the only thing that
  // distinguishes them, and this refusal has to happen before we congratulate
  // ourselves on a valid Mobipocket header.
  if (!lower.endsWith('.epub')) {
    const mobi = lower.endsWith('.mobi') ? ` ${DEAD_FORMAT_NOTE}` : '';
    return {
      state: 'rejected',
      detail: `"${name}" is not an EPUB.${mobi} Nothing was sent.`,
    };
  }
  return epubVerdict(name, bytes);
}

/**
 * 🔴 AN EPUB IS A ZIP, BUT A ZIP IS NOT AN EPUB.
 *
 * Checking only `PK\x03\x04` would pass every `.rar`-in-disguise, every archive,
 * and every renamed installer that happens to be zip-based. The EPUB container
 * spec requires the FIRST entry to be named `mimetype` and to contain exactly
 * `application/epub+zip`, which puts both strings at fixed offsets:
 *
 *   0..4    50 4b 03 04            local file header
 *   30..38  "mimetype"             first entry's name
 *   38..58  "application/epub+zip" first entry's data
 *
 * ⚠️ **DO NOT ALSO ASSERT THE GENERAL PURPOSE FLAGS.** The spec says that first
 * entry must be stored with **flags 0**, and real books in the wild are not. A
 * genuine `Project Hail Mary - Andy Weir.epub`, pulled from a live #ebooks bot
 * on 2026-08-26 and confirmed by `file(1)` as an EPUB document, has:
 *
 *   offset 6..8   16 08  ->  flags  0x0816   <- NOT ZERO. Spec says it must be.
 *   offset 8..10  00 00  ->  method 0        <- stored, as it happens
 *
 * So a validator asserting `flags === 0` would **reject a real book.** (Method
 * on this file *is* stored, so that particular assertion would have survived —
 * naming the wrong field here would send the next reader hunting a trap that is
 * one field over. The dangerous one is FLAGS.)
 *
 * Check the strings. Not the header fields. This is measured, not reasoned.
 */
function epubVerdict(name: string, bytes: Buffer): EbookVerdict {
  if (!hasZipMagic(bytes)) {
    return {
      state: 'rejected',
      detail:
        `"${name}" is named .epub but is not even a ZIP — it looks like ${describeBytes(bytes)}. ` +
        'Nothing was sent.',
    };
  }
  if (bytes.length < 58) {
    return {
      state: 'rejected',
      detail: `"${name}" is a ZIP but is only ${bytes.length} bytes — far too short to be a book.`,
    };
  }
  const entryName = bytes.subarray(30, 38).toString('latin1');
  const mimetype = bytes.subarray(38, 38 + EPUB_MIMETYPE.length).toString('latin1');
  if (entryName !== 'mimetype' || mimetype !== EPUB_MIMETYPE) {
    return {
      state: 'rejected',
      detail:
        `"${name}" is a ZIP but not an EPUB — its first entry is ` +
        `"${printable(entryName)}", not the required "mimetype"/"${EPUB_MIMETYPE}". ` +
        'A renamed archive looks exactly like this. Nothing was sent.',
    };
  }
  return { state: 'ok', format: 'epub', detail: `"${name}" is a valid EPUB (${bytes.length} bytes).` };
}

function hasZipMagic(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304;
}

/**
 * Name what the bytes look like, so a refusal is actionable rather than just a
 * "no". Executable signatures are called out by name because those are the ones
 * somebody needs to hear about.
 */
function describeBytes(bytes: Buffer): string {
  const head = bytes.subarray(0, 8);
  const hex = head.toString('hex');
  if (hex.startsWith('4d5a')) return 'a WINDOWS EXECUTABLE (MZ) — report this, do not retry it';
  if (hex.startsWith('7f454c46')) return 'a LINUX EXECUTABLE (ELF) — report this, do not retry it';
  if (hex.startsWith('cffaedfe') || hex.startsWith('cefaedfe')) {
    return 'a MAC EXECUTABLE (Mach-O) — report this, do not retry it';
  }
  if (hex.startsWith('526172211a07')) return 'a RAR archive';
  if (hex.startsWith('504b0304')) return 'a plain ZIP archive';
  if (hex.startsWith('25504446')) return 'a PDF';
  if (hex.startsWith('1a45dfa3')) return 'a Matroska/WebM video';
  if (hex.startsWith('494433') || hex.startsWith('fffb')) return 'an MP3 audio file';
  return `unrecognised data (starts ${hex.slice(0, 16)})`;
}

/** Render a byte run for a human without letting control characters through. */
function printable(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '.');
}
