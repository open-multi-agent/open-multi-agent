/**
 * Shared keyword-affinity helpers used by capability-match scheduling
 * and short-circuit agent selection. Kept in one place so behaviour
 * can't drift between Scheduler and Orchestrator.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'are', 'from', 'have',
  'will', 'your', 'you', 'can', 'all', 'each', 'when', 'then', 'they',
  'them', 'their', 'about', 'into', 'more', 'also', 'should', 'must',
])

/**
 * Tokenise `text` into a deduplicated set of lower-cased keywords.
 * Words shorter than 4 characters and entries in {@link STOP_WORDS}
 * are filtered out.
 */
export function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
    ),
  ]
}

/**
 * Count how many `keywords` appear (case-insensitively) in `text`.
 * Each keyword contributes at most 1 to the score.
 */
export function keywordScore(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase()
  return keywords.reduce(
    (acc, kw) => acc + (lower.includes(kw.toLowerCase()) ? 1 : 0),
    0,
  )
}
