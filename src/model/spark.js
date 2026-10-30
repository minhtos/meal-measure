// Contract A — Spark photo food identification. The model identifies and
// estimates grams; it never supplies nutrients. Any nutrient-like field in a
// response is dropped here and flagged in provenance.
import { getMode, loadFixture, mockProvenance, liveNotImplemented } from './mock.js';

const NUTRIENT_KEY = /calor|kcal|energy|protein|fat|carb|sugar|fib(er|re)|sodium|nutrient|macro|cholesterol|vitamin/i;
const ITEM_KEYS = ['itemId', 'regionId', 'name', 'preparation', 'alternatives', 'grams', 'confidence', 'bbox'];
const MAX_GRAMS = 3000;
const CONTAINERS = new Set(['plate', 'bowl', 'box', 'cup', 'wrapper', 'none']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const conf = (v) => (num(v) !== null && v >= 0 && v <= 1 ? v : 0);

function cleanGrams(g) {
  if (!g) return null;
  const { low, likely, high } = g;
  const ok = [low, likely, high].every((v) => num(v) !== null) && low > 0 && low <= likely && likely <= high && high <= MAX_GRAMS;
  return ok ? { low, likely, high } : null;
}

// Whitelist-copy known keys (unknown keys dropped); report whether a dropped
// key looked like a nutrient so provenance can say so.
function cleanItem(raw, index, state) {
  if (Object.keys(raw).some((k) => !ITEM_KEYS.includes(k) && NUTRIENT_KEY.test(k))) state.stripped = true;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    itemId: typeof raw.itemId === 'string' ? raw.itemId : `i${index + 1}`,
    regionId: typeof raw.regionId === 'string' ? raw.regionId : null,
    name: raw.name.trim(),
    preparation: typeof raw.preparation === 'string' ? raw.preparation : null,
    alternatives: (Array.isArray(raw.alternatives) ? raw.alternatives : [])
      .filter((a) => typeof a?.name === 'string')
      .slice(0, 5)
      .map((a) => ({ name: a.name, confidence: conf(a.confidence) })),
    grams: cleanGrams(raw.grams), // null => pipeline treats the item as needs_portion
    confidence: conf(raw.confidence),
    bbox: Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : null,
  };
}

function cleanContext(raw = {}) {
  const container = raw.container && CONTAINERS.has(raw.container.type)
    ? { type: raw.container.type, confidence: conf(raw.container.confidence) }
    : { type: 'none', confidence: 0 };
  const sign = (s) => (s && typeof s.text === 'string' ? { text: s.text, confidence: conf(s.confidence) } : null);
  return {
    container,
    brandMarks: (Array.isArray(raw.brandMarks) ? raw.brandMarks : []).map(sign).filter(Boolean),
    placeHint: sign(raw.placeHint),
    scaleVisible: raw.scaleVisible === true,
  };
}

export async function identifyFood(photoRef, opts = {}) {
  if (getMode(opts.env) === 'live') liveNotImplemented('spark.identify');
  const fx = loadFixture('spark.json', photoRef);
  const raw = fx?.data ?? { items: [], context: {} };
  const state = { stripped: Object.keys(raw).some((k) => !['items', 'context'].includes(k) && NUTRIENT_KEY.test(k)) };
  const items = (raw.items ?? []).map((it, i) => cleanItem(it, i, state)).filter(Boolean);
  return {
    items,
    context: cleanContext(raw.context),
    provenance: {
      ...mockProvenance('spark.identify', fx?.label ?? 'FIXTURE — no recording for this photo; empty result'),
      strippedNutrientFields: state.stripped,
    },
  };
}
