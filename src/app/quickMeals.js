// Quick meals: meals already logged that carry a stored user decision (a corrected food, or
// grams the user entered / confirmed on a scale). Logging one again copies the stored entry,
// with the nutrients and provenance it was logged with, as a new entry.
import { createHash, randomUUID } from 'node:crypto';

const LIMIT = 8;
const DECIDED_PORTION = ['user-entered', 'scale-confirmed'];

const itemDecided = (i) => i.food.source === 'user-corrected' || DECIDED_PORTION.includes(i.portion.source);
const hasDecision = (entry) => entry.items.some(itemDecided);
const idOf = (entry) => createHash('sha256')
  .update(entry.items.map((i) => `${i.food.name}|${Math.round(i.portion.loggedGrams)}`).join('\n'))
  .digest('hex').slice(0, 12);

// rows: [{ day, entry }] oldest first -> newest first, one per distinct item/grams set.
export function quickMeals(rows) {
  const seen = new Set();
  const out = [];
  for (const { entry } of [...rows].reverse()) {
    if (!hasDecision(entry)) continue;
    const quickId = idOf(entry);
    if (seen.has(quickId)) continue;
    seen.add(quickId);
    out.push({
      quickId,
      lastLoggedAt: entry.loggedAt,
      items: entry.items.map((i) => ({ name: i.food.name, loggedGrams: i.portion.loggedGrams, corrected: i.food.source === 'user-corrected' })),
      kcal: Math.round(entry.items.reduce((s, i) => s + i.logged.kcal, 0)),
    });
    if (out.length === LIMIT) break;
  }
  return out;
}

// -> a fresh logged entry for the quick meal, or null when the id is unknown.
export function relogQuickMeal(rows, quickId, now = new Date()) {
  const row = [...rows].reverse().find((r) => hasDecision(r.entry) && idOf(r.entry) === quickId);
  if (!row) return null;
  return { ...structuredClone(row.entry), entryId: randomUUID(), loggedAt: now.toISOString(), quickMealOf: row.entry.entryId };
}
