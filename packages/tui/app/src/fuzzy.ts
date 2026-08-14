/**
 * Subsequence ("fuzzy") matching for the slash-command menu and the picker
 * dialogs, in the spirit of pi's fuzzy.ts: every query character must appear
 * in order; consecutive runs and word-boundary hits score higher.
 * @module @deepseek-ai/dsh-tui-app/fuzzy
 */

/**
 * Score one candidate against the query.
 * @param query - what the user typed; an empty query matches everything at 0.
 * @param candidate - the row text to match against.
 * @returns the score (higher is better), or null when the query is not a subsequence.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query === '') return 0
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  let score = 0
  let streak = 0
  let qi = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) {
      streak += 1
      score += 10 + streak * 4
      // Word-start hits (after a separator) read as intentional matches.
      if (ci === 0 || /[\s/_\-.:]/u.test(c[ci - 1] ?? '')) score += 6
      qi += 1
    } else {
      streak = 0
    }
  }
  if (qi !== q.length) return null
  // Prefer compact candidates: penalize length and a late first hit.
  return score - c.length - c.indexOf(q[0] ?? '')
}

/**
 * Filter and rank items by fuzzy score, keeping the input order on ties.
 * @param items - candidates to filter.
 * @param query - the user query.
 * @param key - extracts the matchable text from one item.
 * @returns matching items, best first.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, key(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item)
}
