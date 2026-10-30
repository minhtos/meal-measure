// USDA FoodData Central search client. The key comes from process.env only and
// is sent in a header, so it never appears in a URL, cache file, or error.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const CACHE_DIR = new URL('../../.cache/usda/', import.meta.url); // gitignored
// FDC nutrient numbers: 208 energy (kcal), 203 protein, 205 carbohydrate, 204 total fat.
const NUMBERS = { 208: 'kcal', 203: 'protein', 205: 'carbs', 204: 'fat' };

export class NoUsdaKeyError extends Error {
  constructor() {
    super('USDA FoodData Central: no key in env (set USDA_API_KEY)');
    this.name = 'NoUsdaKeyError';
  }
}

export const hasUsdaKey = (env = process.env) => Boolean(env.USDA_API_KEY);

export function per100gFromFood(food) {
  const out = {};
  for (const n of food.foodNutrients ?? []) {
    const key = NUMBERS[Number(n.nutrientNumber)];
    if (key && typeof n.value === 'number') out[key] = n.value;
  }
  return ['kcal', 'protein', 'carbs', 'fat'].every((k) => k in out) ? out : null;
}

// opts.fetch lets callers inject a transport; opts.env defaults to process.env.
export async function searchFoods(query, opts = {}) {
  const env = opts.env ?? process.env;
  if (!hasUsdaKey(env)) throw new NoUsdaKeyError();

  const cacheFile = new URL(`${createHash('sha256').update(query.toLowerCase()).digest('hex')}.json`, CACHE_DIR);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    /* cache miss */
  }
  if (!cached) {
    const url = `${BASE}?${new URLSearchParams({ query, pageSize: '5', dataType: 'Foundation,SR Legacy' })}`;
    const res = await (opts.fetch ?? fetch)(url, { headers: { 'X-Api-Key': env.USDA_API_KEY } });
    if (!res.ok) throw new Error(`USDA FoodData Central search failed: HTTP ${res.status}`);
    cached = { fetchedAt: new Date().toISOString(), body: await res.json() };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cached));
  }
  return (cached.body.foods ?? [])
    .map((f) => ({ id: f.fdcId, description: f.description, dataType: f.dataType, per100g: per100gFromFood(f), fetchedAt: cached.fetchedAt }))
    .filter((f) => f.per100g);
}
