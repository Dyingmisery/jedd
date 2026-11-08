/**
 * Deciding WHAT the user meant, from catalogue results.
 *
 * ── 🔴 NOTHING HERE GUESSES A MEDIA TYPE FROM THE MESSAGE ────────────────────
 *
 * Measured over 806 real user turns: the dominant utterance is **`verb + bare
 * title` with no type marker** — *"add whiplash"*, *"Get hook"*, *"do you have
 * the office?"*. **The title IS the entire payload and the user almost never
 * says whether they mean a film or a show.**
 *
 * So type disambiguation is the COMMON case, not an edge case, and V1's
 * `detectMediaType` was not merely vestigial — it was **structurally wrong for
 * the modal request**. Both catalogues are searched, always, and the decision is
 * made from RESULTS rather than from a guess about the message.
 */

export interface Candidate {
  /** Catalogue id — a tmdbId for a film, a tvdbId for a series. */
  id: number;
  title: string;
  year?: number;
  /** Sonarr network name when present (series only), e.g. "ABC (US)". */
  network?: string;
  /** Relative popularity within its own catalogue, when the source provides it. */
  popularity?: number;
  /**
   * External poster URL from the arr lookup (`remotePoster` or an images
   * entry's `remoteUrl`). Never the local `url`, which is a cover path.
   */
  posterUrl?: string;
}

export type MediaType = 'movie' | 'series';

/** Normalise for comparison: case, punctuation, articles, and spacing. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

/**
 * How well a candidate matches, 0..1. **Comparative use only.**
 *
 * 🔴 V1 used an ABSOLUTE floor and it failed on ordinary short titles: a
 * two-word title by a two-word author scores low against everything, so nothing
 * cleared the bar. The fix is scale-free — *"does this candidate match better
 * than the alternatives"* — so this number is meaningful only when compared with
 * other candidates' numbers for the SAME query.
 */
export function matchScore(query: string, candidate: string): number {
  const q = normalise(query);
  const c = normalise(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = new Set(q.split(' '));
  const ct = new Set(c.split(' '));
  let shared = 0;
  for (const t of qt) if (ct.has(t)) shared += 1;
  // Penalise extra words on the candidate so "Dune: Part Two" does not tie
  // "Dune" for the query "dune".
  const union = new Set([...qt, ...ct]).size;
  return shared / union;
}

export interface Pick {
  best: Candidate;
  score: number;
  /** True when the runner-up is close enough that picking silently would guess. */
  contested: boolean;
}

/**
 * The best candidate, or nothing.
 *
 * 🔴 **`results[0]` IS NEVER A SILENT FALLBACK.** This is the "Ghost Dad"
 * control: V1 accepted the first result when nothing matched well, so a request
 * for one film could add a completely unrelated one. If no candidate resembles
 * the query, the answer is NOTHING, and the caller must ask rather than pick.
 */
/**
 * How much resemblance is enough to be worth showing a person.
 *
 * 🔴 ONE CONSTANT, TWO CALLERS. `pickBest` and `plausible` must agree about what
 * "resembles the query" means: a title good enough to be picked but not good
 * enough to be listed — or the reverse — is a disagreement between two answers
 * about the same library, which is the shape this project keeps eliminating.
 */
export const MATCH_FLOOR = 0.34;

/** Soft presentation rank only — never a silent auto-pick. Higher = more preferred. */
export function networkPreference(network: string | undefined): number {
  const n = (network ?? '').toLowerCase();
  if (!n) return 0;
  // US broadcast / major US streamers
  if (
    /\b(abc|nbc|cbs|fox|the cw|cw|hbo|max|netflix|hulu|disney\+?|amc|showtime|paramount\+?|peacock|usa network|espn|fx|tnt|tbs|syfy|freeform)\b/.test(
      n,
    ) ||
    /\(us\)|\bunited states\b|\bus\b/.test(n)
  ) {
    return 2;
  }
  // Other English-primary networks
  if (/\b(bbc|itv|channel 4|channel 5|sky|stan|nine|seven|ten|cbc|ctv|global)\b/.test(n) || /\(uk\)|\(ca\)|\(au\)/.test(n)) {
    return 1;
  }
  return 0;
}

function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

/**
 * Near-exact title matches that disagree on network must never resolve silently.
 * Score-tie contested still applies; this catches same-title franchises across nets.
 */
function multiNetworkNearExact(scored: { c: Candidate; s: number }[]): boolean {
  const near = scored.filter((x) => x.s >= 0.99);
  if (near.length < 2) return false;
  const byTitle = new Map<string, Set<string>>();
  for (const { c } of near) {
    const key = normaliseTitle(c.title);
    const net = (c.network ?? '').trim().toLowerCase();
    if (!net) continue;
    let set = byTitle.get(key);
    if (!set) {
      set = new Set();
      byTitle.set(key, set);
    }
    set.add(net);
  }
  for (const nets of byTitle.values()) {
    if (nets.size >= 2) return true;
  }
  return false;
}

/** Best-first, with US/English network soft preference only on equal title scores. */
export function orderForDisplay(query: string, candidates: Candidate[]): Candidate[] {
  return [...candidates]
    .map((c) => ({ c, s: matchScore(query, c.title), pref: networkPreference(c.network) }))
    .sort((a, b) => b.s - a.s || b.pref - a.pref)
    .map((x) => x.c);
}

export function pickBest(query: string, candidates: Candidate[]): Pick | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((c) => ({ c, s: matchScore(query, c.title) }))
    .sort((a, b) => b.s - a.s || networkPreference(b.c.network) - networkPreference(a.c.network));
  const top = scored[0]!;
  if (top.s < MATCH_FLOOR) return null; // resembles nothing; do not fall back to [0]
  const runner = scored[1];
  const contestedByScore = Boolean(runner && top.s - runner.s < 0.15);
  const contestedByNetwork = multiNetworkNearExact(scored);
  const contested = contestedByScore || contestedByNetwork;
  return { best: top.c, score: top.s, contested };
}

export type TypeVerdict =
  | { type: 'movie'; pick: Pick }
  | { type: 'series'; pick: Pick }
  | { type: 'ambiguous'; movie: Pick; series: Pick; detail: string }
  | { type: 'none'; detail: string };

/**
 * Which catalogue the user meant, decided from RESULTS.
 *
 * 🔴 THE MONEYBALL RULE, AND IT IS WHAT MAKES THAT DEFECT IMPOSSIBLE RATHER THAN
 * UNLIKELY.
 *
 * V1 added **Moneyball (2021), a TV series**, when the ask was the **2011 film**.
 * A code-level router picked the type and picked wrong.
 *
 * Two things change here, and only the first is an absolute:
 *
 * 1. **No code infers a type from the message any more**, so that class of
 *    routing bug cannot occur — there is no router left to be wrong.
 * 2. **When a bare title matches plausibly in BOTH catalogues, this returns
 *    `ambiguous` and the caller MUST NOT ADD.** It presents the options and asks.
 *    That is a code rule, not a model judgement, so a silent cross-type add is
 *    unreachable for exactly the shape of title — one that exists as both a film
 *    and a show — that produced the defect.
 *
 * **Being honest about the residue:** if only ONE catalogue matches, the model
 * still chooses whether to act, and a model can still misread a request. What is
 * eliminated is the *silent* cross-type add on an ambiguous title. The remaining
 * risk is a visible pick the user can correct, not an invisible one.
 */
export function typeVerdict(
  query: string,
  movies: Candidate[],
  series: Candidate[],
): TypeVerdict {
  const m = pickBest(query, movies);
  const s = pickBest(query, series);

  if (m && s) {
    return {
      type: 'ambiguous',
      movie: m,
      series: s,
      detail:
        `"${query}" matches BOTH a film (${m.best.title}${m.best.year ? ` ${m.best.year}` : ''}) and a ` +
        `series (${s.best.title}${s.best.year ? ` ${s.best.year}` : ''}). Do NOT add either. Present both ` +
        'and ask which they meant — a bare title does not say.',
    };
  }
  if (m) return { type: 'movie', pick: m };
  if (s) return { type: 'series', pick: s };
  return {
    type: 'none',
    detail: `Nothing in either catalogue resembles "${query}". Say so; do not offer the closest thing.`,
  };
}

/**
 * EVERY title that resembles the query, best first — not just the best one.
 *
 * `pickBest` answers *"which one did they mean"* and is deliberately willing to
 * answer nothing. This answers *"which ones are worth telling them about"*,
 * which is a different question: a query like *"star trek"* legitimately matches
 * several owned shows, and collapsing them to one would hide the rest of the
 * library from the person asking what is in it.
 *
 * Same floor as `pickBest`, so the two never disagree about what resembles what.
 */
export function plausible<T extends { title: string }>(query: string, rows: T[], limit = 3): T[] {
  return rows
    .map((r) => ({ r, s: matchScore(query, r.title) }))
    .filter((x) => x.s >= MATCH_FLOOR)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
