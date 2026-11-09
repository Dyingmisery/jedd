import type { Config } from './config.js';

export type Role = 'owner' | 'guest';

/**
 * Normalise a messaging handle for comparison.
 *
 * 🔴 THIS DELIBERATELY DOES NOT COMPARE BY SUFFIX.
 *
 * The first version collapsed phone-shaped handles to their **last 10 digits**,
 * which made `+448015550123`, `008015550123` and `9998015550123` all resolve to
 * the owner — a complete authentication bypass for anyone who can pick their own
 * handle. Its unit test used a one-digit-different number, which shares no
 * suffix, so the test was structurally incapable of detecting the bug.
 *
 * The rule now: strip formatting punctuation, normalise a leading `+`, and treat
 * a bare 10-digit US number as equivalent to the same number with a `1` country
 * code. Nothing else is equated. Two handles match only if they are the same
 * handle.
 */
export function normaliseHandle(handle: string): string {
  // 🔴 A non-string (an absent config key arrives as `undefined`) is NOT an
  // identity. Returning '' makes it a guest; letting `.trim()` throw would send
  // a TypeError up through the gate, and a caller that catches broadly could
  // turn that into any answer at all. Deny explicitly instead of throwing.
  if (typeof handle !== 'string') return '';

  const trimmed = handle.trim().toLowerCase();
  if (!trimmed) return '';

  // Phone-shaped only if it is digits plus formatting punctuation.
  if (/^\+?[\d\s()./-]+$/.test(trimmed)) {
    let digits = trimmed.replace(/\D/g, '');
    if (!digits) return '';
    // A bare 10-digit US number is the same number as `1` + those 10 digits.
    // This is an EXACT widening of one known case, not a suffix match.
    if (digits.length === 10) digits = `1${digits}`;
    /**
     * 🔴 TOO FEW DIGITS TO BE ANYBODY.
     *
     * Measured fail-OPEN this guard closes: `OWNER_HANDLE="+1 () -."` normalised
     * to `tel:1`, and so did a sender whose handle was `1` — so a typo in the
     * config GRANTED OWNER to a junk handle. The gate compares normalised forms
     * for equality, which means every value that survives normalisation is a
     * usable identity, and a one-digit fragment must not be one.
     *
     * 11 digits is the real floor: US numbers reach it via the `1` prepended
     * above, and longer international forms pass through untouched.
     */
    if (digits.length < 11) return '';
    return `tel:${digits}`;
  }

  /**
   * 🔴 Punctuation with no alphanumeric content is not an identity either.
   * `OWNER_HANDLE="+"` fell through to here and returned `'+'`, which compared
   * EQUAL to a sender handle of `'+'` — the same fail-open by the other route,
   * because `+` is not phone-shaped enough to reach the digit check above.
   */
  if (!/[a-z0-9]/.test(trimmed)) return '';

  return trimmed;
}

/**
 * THE permission decision. One owner; everybody else is a guest.
 *
 * Fails closed: an empty, malformed or unrecognised handle is a guest. There is
 * no path through this function that promotes an unknown sender.
 */
export function roleFor(senderHandle: string, config: Config): Role {
  if (!senderHandle) return 'guest';
  const sender = normaliseHandle(senderHandle);
  if (!sender) return 'guest';
  const owner = normaliseHandle(config.ownerHandle);
  if (!owner) return 'guest';
  return sender === owner ? 'owner' : 'guest';
}

/** Same person, after the handle normalisation above. Empty handles never match. */
export function sameHandle(a: string, b: string): boolean {
  const left = normaliseHandle(a);
  const right = normaliseHandle(b);
  return left.length > 0 && left === right;
}

/**
 * Who may search, download, and email an ebook.
 *
 * The owner always may. A guest may only when their handle is listed in
 * `JEDD_KINDLE_SENDERS`. Everyone else is refused. This is not an admin grant
 * and it does not change who may be texted (`JEDD_SEND_TO`).
 *
 * `onlySendTo`, when set, is a stricter test seam and still wins.
 */
export function mayRequestKindle(senderHandle: string, config: Config, onlySendTo?: string): boolean {
  if (onlySendTo && !sameHandle(senderHandle, onlySendTo)) return false;
  if (sameHandle(senderHandle, config.ownerHandle)) return true;
  return config.kindleSenders.some((handle) => sameHandle(senderHandle, handle));
}

export function roleSatisfies(actual: Role, required: Role): boolean {
  if (required === 'guest') return true;
  return actual === 'owner';
}
