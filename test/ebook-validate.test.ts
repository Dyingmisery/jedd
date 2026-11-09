import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEbookBytes } from '../src/media/ebook-validate.js';

/**
 * The header of a REAL book: `Project Hail Mary - Andy Weir.epub`, DCC-fetched
 * from the live #ebooks bot `Bsk` on 2026-08-26 and confirmed by `file(1)` as an
 * `EPUB document`.
 *
 * 🔴 It is transcribed byte-for-byte rather than synthesised, because a
 * synthetic fixture would have been built to the SPEC and the spec is not what
 * the wild contains. Note `16 08` at offset 6 — general purpose flags `0x0816`,
 * which the EPUB spec says must be zero. Any validator that asserts that field
 * rejects this book, and only a real sample can prove it.
 */
const REAL_EPUB_HEAD = Buffer.from(
  '504b03041400160800004' + '7b9a3526f61ab2c140000001400000008000000' + '6d696d6574797065' +
    Buffer.from('application/epub+zip', 'latin1').toString('hex'),
  'hex',
);

function epub(extra = 2000): Buffer {
  return Buffer.concat([REAL_EPUB_HEAD, Buffer.alloc(extra, 0x41)]);
}

test('the real bot-supplied EPUB header validates', () => {
  const v = validateEbookBytes('Project Hail Mary - Andy Weir.epub', epub());
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') assert.equal(v.format, 'epub');
});

test('🔴 the real EPUB has NON-ZERO general purpose flags — the trap this fixture exists for', () => {
  // If this ever fails, the fixture stopped being the real-world sample and the
  // test above stopped proving anything.
  assert.equal(REAL_EPUB_HEAD.readUInt16LE(6), 0x0816);
  assert.notEqual(REAL_EPUB_HEAD.readUInt16LE(6), 0, 'spec says 0; the wild says otherwise');
  // ...while the compression method on this same file IS the conformant value,
  // which is why naming the wrong field would mislead.
  assert.equal(REAL_EPUB_HEAD.readUInt16LE(8), 0);
});

test('a renamed Windows executable is refused and NAMED', () => {
  const exe = Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), Buffer.alloc(3000, 0)]);
  const v = validateEbookBytes('Project Hail Mary.epub', exe);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /WINDOWS EXECUTABLE/);
  assert.match(v.detail, /report this/i);
});

test('a plain ZIP that is not an EPUB is refused — ZIP magic alone is not enough', () => {
  const zip = Buffer.concat([
    Buffer.from('504b03041400000008000000000000000000000000000000000009000000', 'hex'),
    Buffer.from('evil.exe/'.padEnd(29, '\0'), 'latin1'),
    Buffer.alloc(2000, 0x41),
  ]);
  const v = validateEbookBytes('book.epub', zip);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /not an EPUB/);
});

test('a RAR renamed to .epub is refused and identified as a RAR', () => {
  const rar = Buffer.concat([Buffer.from('526172211a0700', 'hex'), Buffer.alloc(2000, 0)]);
  const v = validateEbookBytes('book.epub', rar);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /not even a ZIP/);
  assert.match(v.detail, /RAR/);
});

test('🔴 .mobi is REFUSED even though the bytes are a genuine Mobipocket file', () => {
  const mobi = Buffer.concat([Buffer.alloc(60, 0), Buffer.from('BOOKMOBI', 'latin1'), Buffer.alloc(2000, 0)]);
  const v = validateEbookBytes('Project Hail Mary.mobi', mobi);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /2022/);
  // The refusal must explain the invisibility, since that is the whole reason
  // declining beats attaching.
  assert.match(v.detail, /never arrive|silently/i);
});

test('an AZW3 is not an EPUB and is not mailed', () => {
  const azw3 = Buffer.concat([Buffer.alloc(60, 0), Buffer.from('BOOKMOBI', 'latin1'), Buffer.alloc(2000, 0)]);
  const v = validateEbookBytes('Project Hail Mary.azw3', azw3);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /not an EPUB/);
});

test('a PDF is not an EPUB and is not mailed', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(2000, 0x41)]);
  const v = validateEbookBytes('a.pdf', pdf);
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /not an EPUB/);
});

test('an unknown extension is refused rather than attempted', () => {
  const v = validateEbookBytes('book.rar', Buffer.from('526172211a0700', 'hex'));
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /not an EPUB/);
});

test('zero bytes is refused', () => {
  assert.equal(validateEbookBytes('a.epub', Buffer.alloc(0)).state, 'rejected');
});

test('a truncated ZIP is refused rather than read out of bounds', () => {
  const v = validateEbookBytes('a.epub', Buffer.from('504b0304140016080000', 'hex'));
  assert.equal(v.state, 'rejected');
  assert.match(v.detail, /too short/);
});

test('control characters in a corrupt header cannot reach the reported message', () => {
  const nasty = Buffer.concat([
    Buffer.from('504b0304140016080000', 'hex'),
    Buffer.alloc(20, 0),
    Buffer.from('\x07\x1b[31mBAD\x00\x00', 'latin1'),
    Buffer.alloc(2000, 0),
  ]);
  const v = validateEbookBytes('a.epub', nasty);
  assert.equal(v.state, 'rejected');
  assert.doesNotMatch(v.detail, /\x1b|\x07/);
});
