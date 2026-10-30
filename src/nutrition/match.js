// Food-match scoring: how well a database record's name fits the identified
// food, a form-sanity check, and the near-miss thresholds (docs/INTEGRATION.md
// §6.1). Pure functions; no I/O, no model imports.

export const NEAR_MISS = {
  closeScores: 0.15, // top-2 gap, as a fraction of the top score, at or under which they are a toss-up
  minScore: 0.5, // a winner scoring below this is a weak match
  minIdentConfidence: 0.5, // Spark identification confidence below this is low
};
export const MAX_CANDIDATES = 5;

// Light plural stem so "cubes"/"cube" and "eggs"/"egg" meet.
const stem = (t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
const tokens = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem));

// Dice coefficient over name tokens, 0..1 (3 decimals). Penalises both missing
// and extra words, so "chicken broth" prefers "chicken broth, ready-to-serve"
// over a long record that merely mentions it.
export function scoreMatch(query, recordName) {
  const q = tokens(query);
  const r = tokens(recordName);
  if (!q.size || !r.size) return 0;
  let shared = 0;
  for (const t of q) if (r.has(t)) shared++;
  return Math.round(((2 * shared) / (q.size + r.size)) * 1000) / 1000;
}

// Dry / concentrated / reconstitutable forms. A record naming one of these for
// a food whose own name does not is a form mismatch (dry bouillon vs broth).
const CONCENTRATED = ['dry', 'dried', 'dehydrated', 'powder', 'powdered', 'concentrate', 'concentrated', 'bouillon', 'cube', 'mix', 'instant'];

// The concentrated-form term that makes the record suspect for this food, else null.
export function formConcern(query, recordName) {
  const q = tokens(query);
  const r = tokens(recordName);
  return CONCENTRATED.find((t) => r.has(t) && !q.has(t)) ?? null;
}

// rows: {db, id, name, dataType, per100g, fetchedAt, score?}. A row may carry
// its own score (an exact barcode hit is 1). Sorted by score, descending; ties
// keep the database's own order. Nothing is dropped except the cap of five.
export function rankCandidates(query, rows) {
  return rows
    .map((r, i) => ({
      candidateId: `${r.db}:${r.id}`,
      db: r.db,
      id: r.id,
      name: r.name,
      dataType: r.dataType,
      per100g: r.per100g,
      score: r.score ?? scoreMatch(query, r.name),
      formConcern: formConcern(query, r.name),
      fetchedAt: r.fetchedAt ?? null,
      _i: i,
    }))
    .sort((a, b) => b.score - a.score || a._i - b._i)
    .slice(0, MAX_CANDIDATES)
    .map(({ _i, ...c }) => c);
}

// Why this match deserves a second look (empty = clear winner). The first
// candidate is the winner. identificationConfidence is Spark's number, or
// 'confirmed' once the user has decided.
export function nearMissReasons(candidates, identificationConfidence) {
  const [win, second] = candidates;
  if (!win) return [];
  const reasons = [];
  if (second && win.score - second.score <= NEAR_MISS.closeScores * win.score) reasons.push('close-scores');
  if (win.score < NEAR_MISS.minScore) reasons.push('low-score');
  if (typeof identificationConfidence === 'number' && identificationConfidence < NEAR_MISS.minIdentConfidence) reasons.push('low-identification-confidence');
  if (win.formConcern) reasons.push('form-concern');
  return reasons;
}
