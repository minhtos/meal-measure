// Day log: logged entries (from logEntry) grouped by day, with plain sums. Sums are ranges
// (low / likely / high); nothing here compares them to anything.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { NUTRIENT_KEYS } from '../nutrition/nutrients.js';

const round1 = (v) => Math.round(v * 10) / 10;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// items: [{ nutrients: {kcal:{low,likely,high},...} | null }] -> { kcal:{low,likely,high}, ... }
export function sumNutrients(items) {
  const out = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, { low: 0, likely: 0, high: 0 }]));
  for (const it of items) {
    if (!it.nutrients) continue;
    for (const k of NUTRIENT_KEYS) for (const b of ['low', 'likely', 'high']) out[k][b] += it.nutrients[k][b];
  }
  for (const k of NUTRIENT_KEYS) for (const b of ['low', 'likely', 'high']) out[k][b] = round1(out[k][b]);
  return out;
}

export const localDay = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD
export const isDay = (s) => typeof s === 'string' && DAY.test(s);

// Per-item tags shown next to each logged item.
const SOURCE_TAG = { 'photo-estimate': 'estimate', 'user-entered': 'entered grams', 'scale-confirmed': 'scale (verified)' };
const FOOD_TAG = { spark: 'identified from photo', 'user-corrected': 'corrected', barcode: 'scanned barcode' };

function entryView(e) {
  const items = e.items.map((i) => ({
    itemId: i.itemId,
    name: i.food.name,
    grams: i.portion.grams,
    loggedGrams: i.portion.loggedGrams,
    nutrients: i.nutrients,
    tags: {
      portion: SOURCE_TAG[i.portion.source] ?? i.portion.source,
      portionConfidence: i.portion.confidence,
      food: FOOD_TAG[i.food.source] ?? i.food.source,
      foodConfidence: i.food.identificationConfidence,
      database: i.nutrientSource ? i.nutrientSource.db : null,
    },
  }));
  return { entryId: e.entryId, loggedAt: e.loggedAt, items, totals: sumNutrients(items) };
}

// file: JSON path for persistence, or null for memory only.
export function createDayLog(file = null) {
  let rows = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  return {
    add(logged, day = localDay()) {
      rows.push({ day, entry: logged });
      if (file) writeFileSync(file, JSON.stringify(rows));
      return entryView(logged);
    },
    rows: () => rows,
    view(day = localDay()) {
      const entries = rows.filter((r) => r.day === day).map((r) => entryView(r.entry));
      return { day, entries, totals: sumNutrients(entries.flatMap((e) => e.items)) };
    },
  };
}
