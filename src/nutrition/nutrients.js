// Code-only nutrient math: nutrient = grams × per100g / 100.
export const NUTRIENT_KEYS = ['kcal', 'protein', 'carbs', 'fat'];

// The logged portion for a range: round((low + high) / 2) grams.
export function rangeMiddle(low, high) {
  return Math.round((low + high) / 2);
}

const at = (per100, grams) => Math.round(((per100 * grams) / 100) * 10) / 10;

// grams: {low, high}. Returns {kcal:{low,likely,high}, ...} where `likely` is
// the nutrient at the range-middle grams (the logged value).
export function computeNutrients(per100g, grams) {
  const middle = rangeMiddle(grams.low, grams.high);
  const out = {};
  for (const key of NUTRIENT_KEYS) {
    const v = per100g[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`per100g.${key} missing`);
    out[key] = { low: at(v, grams.low), likely: at(v, middle), high: at(v, grams.high) };
  }
  return out;
}
