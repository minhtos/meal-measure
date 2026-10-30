#!/usr/bin/env node
// Nutrient-level scoring of the component-weighed pho meals (003, 005) against BENCHMARK.md.
// Live USDA FoodData Central calls; the key comes from env only:
//   bash -c 'set -a; . ~/.config/usda-api.env; set +a; node scripts/score-nutrients.mjs'
// Reads data/benchmark-components.json, resolves one USDA entry per component (Foundation / SR Legacy
// via src/nutrition/usda.js, plus a Survey (FNDDS) search here, ranked by rankCandidates, skipping
// form-flagged candidates), then computes meal-level kcal / protein / carbs / fat per variant.
// Truth uses the SAME entry as the estimate, so database error is not part of the score.
// Writes web/nutrient-scoring.json (merged into web/benchmark.json by build-benchmark.mjs) and
// replaces the "Nutrient-level scoring" section of BENCHMARK.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { searchFoods, per100gFromFood, hasUsdaKey } from '../src/nutrition/usda.js';
import { rankCandidates } from '../src/nutrition/match.js';

const url = (p) => new URL(p, import.meta.url);
const input = JSON.parse(readFileSync(url('../data/benchmark-components.json'), 'utf8'));
const spark = JSON.parse(readFileSync(url('../data/samples/pho-meal005/spark.json'), 'utf8'));
if (!hasUsdaKey()) throw new Error('no USDA_API_KEY in env; run via the bash -c shape in the header');

// Entry key -> query. Components sharing a key share one USDA entry.
const ENTRIES = {
  broth: 'beef broth',
  'rice-noodles': 'rice noodles, cooked',
  'raw-beef': 'beef round eye of round raw',
  'cooked-beef': 'beef brisket braised',
  'beef-meatballs': 'beef meatballs',
  garnish: 'mung beans sprouts raw',
};
const ENTRY_OF = {
  broth: 'broth', 'rice-noodles': 'rice-noodles', 'raw-beef-slices': 'raw-beef', 'cooked-beef': 'cooked-beef',
  'beef-cuts': 'cooked-beef', 'beef-meatballs': 'beef-meatballs',
  'onion-herbs': 'garnish', 'garnish-sprouts-onion-herbs': 'garnish', garnish: 'garnish',
};
// Spark item names (meal 005 app run) -> component key.
const SPARK_COMPONENT = {
  'beef pho broth': 'broth', 'cooked rice noodles': 'rice-noodles', 'rare beef slices': 'raw-beef-slices',
  'cooked beef brisket': 'cooked-beef', 'beef meatball': 'beef-meatballs', 'bean sprouts': 'garnish',
  'sliced white onion': 'garnish', 'fresh cilantro and green onion': 'garnish',
};

// Survey (FNDDS) search; searchFoods only covers Foundation / SR Legacy. The GET form with
// dataType=Survey returns HTTP 400, so this uses the FDC POST form (JSON body). Two attempts with a
// short backoff on 400/429/5xx; the retry also reduces the query to plain words.
async function surveySearch(query) {
  const plain = query.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000));
    res = await fetch('https://api.nal.usda.gov/fdc/v1/foods/search', {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.USDA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: attempt ? plain : query, dataTypes: ['Survey (FNDDS)'], pageSize: 5 }),
    });
    if (res.ok || !(res.status === 400 || res.status === 429 || res.status >= 500)) break;
  }
  if (!res.ok) throw new Error(`USDA Survey search failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.foods)) throw new Error(`USDA Survey search: unexpected response shape (keys: ${Object.keys(body).join(', ')})`);
  const fetchedAt = new Date().toISOString();
  const rows = body.foods.map((f) => ({ id: f.fdcId, description: f.description, dataType: f.dataType, per100g: per100gFromFood(f), fetchedAt })).filter((f) => f.per100g);
  if (body.foods.length && !rows.length) console.warn(`WARNING: Survey results for "${query}" had no usable kcal/protein/carbs/fat nutrients; response foodNutrients shape may differ`);
  return rows;
}

const entries = {};
for (const [key, query] of Object.entries(ENTRIES)) {
  const rows = [...await searchFoods(query), ...await surveySearch(query)].map((f) => ({ db: 'usda', id: f.id, name: f.description, dataType: f.dataType, per100g: f.per100g, fetchedAt: f.fetchedAt }));
  const ranked = rankCandidates(query, rows);
  const chosen = ranked.find((c) => !c.formConcern);
  if (!chosen) throw new Error(`no unflagged candidate for "${query}"`);
  entries[key] = { query, fdcId: chosen.id, dataType: chosen.dataType, name: chosen.name, score: chosen.score, per100g: chosen.per100g, runnersUp: ranked.filter((c) => c !== chosen).map((c) => `${c.id} ${c.name} (${c.dataType}, ${c.score}${c.formConcern ? `, flagged: ${c.formConcern}` : ''}, ${c.per100g.kcal} kcal)`) };
}

for (const [k, e] of Object.entries(entries)) console.log(`${k}: ${e.fdcId} ${e.dataType} "${e.name}" ${e.per100g.kcal} kcal/100g\n   runners-up: ${e.runnersUp.join(' | ')}`);

// Trap checks on the resolved entries. Warnings are loud and never re-pick; they are also stored in the output JSON.
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn(`\n!!! WARNING: ${msg}\n`); };
const noodles = entries['rice-noodles'];
if (noodles.fdcId !== 168914) {
  warn(`rice noodles resolved to ${noodles.fdcId} "${noodles.name}" (${noodles.per100g.kcal} kcal/100g), expected SR 168914 (108 kcal/100g)`);
} else if (noodles.per100g.kcal !== 108) {
  warn(`rice noodles are SR 168914 but ${noodles.per100g.kcal} kcal/100g, expected 108`);
}
if (![171538, 2707132].includes(entries.broth.fdcId)) {
  warn(`broth resolved to ${entries.broth.fdcId} "${entries.broth.name}", expected SR 171538 or FNDDS 2707132`);
}
for (const k of ['raw-beef', 'cooked-beef', 'beef-meatballs']) {
  if (entries[k].per100g.fat > 35) warn(`${k} entry ${entries[k].fdcId} "${entries[k].name}" has ${entries[k].per100g.fat} g fat/100g (> 35; NZ navel-end trap is 41)`);
}

const KEYS = ['kcal', 'protein', 'carbs', 'fat'];
function sum(components) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const [c, g] of Object.entries(components)) {
    const e = entries[ENTRY_OF[c] ?? (() => { throw new Error(`no entry mapping for component "${c}"`); })()];
    for (const k of KEYS) t[k] += (g * e.per100g[k]) / 100;
  }
  return t;
}
const r1 = (v) => Math.round(v * 10) / 10;

const scores = [];
for (const [id, meal] of Object.entries(input.meals)) {
  const truth = sum(meal.truth.components);
  for (const [name, v] of Object.entries(meal.variants)) {
    let components = v.components;
    let note = '';
    if (!components) { // app-pipeline-run: per-item likely grams from the recorded Spark run
      components = {};
      for (const it of spark.items) {
        const c = SPARK_COMPONENT[it.name] ?? (() => { throw new Error(`unmapped Spark item "${it.name}"`); })();
        components[c] = (components[c] ?? 0) + it.grams.likely;
      }
      note = 'Spark likely grams per item, priced with the same entries';
    }
    const est = sum(components);
    scores.push({
      meal: id, variant: name, note,
      truthG: meal.truth.totalG, estimateG: Object.values(components).reduce((a, b) => a + b, 0),
      truth: Object.fromEntries(KEYS.map((k) => [k, r1(truth[k])])),
      estimate: Object.fromEntries(KEYS.map((k) => [k, r1(est[k])])),
      errorPct: Object.fromEntries(KEYS.map((k) => [k, r1(((est[k] - truth[k]) / truth[k]) * 100)])),
    });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  entries: Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, { query: e.query, fdcId: e.fdcId, dataType: e.dataType, name: e.name, per100g: e.per100g }])),
  componentEntry: ENTRY_OF,
  warnings,
  scores,
};
writeFileSync(url('../web/nutrient-scoring.json'), `${JSON.stringify(out, null, 2)}\n`);

const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
const section = [
  '## Nutrient-level scoring',
  '',
  '<!-- generated by scripts/score-nutrients.mjs; do not edit by hand -->',
  'Meal-level kcal / protein / carbs / fat for the component-weighed pho meals, from live USDA FoodData Central lookups. Truth and estimate use the **same** entry per component, so this scores identification-and-portion error only, not database error. Component weights: `data/benchmark-components.json`.',
  '',
  '| Component entry | FDC id | Data type | USDA name | kcal /100 g |',
  '|---|---|---|---|---|',
  ...Object.entries(entries).map(([k, e]) => `| ${k} | ${e.fdcId} | ${e.dataType} | ${e.name} | ${e.per100g.kcal} |`),
  '',
  `Components map to entries as: ${Object.entries(ENTRY_OF).map(([c, e]) => `${c} → ${e}`).join('; ')}.`,
  '',
  '| Meal | Variant | Weight truth → est. | kcal truth → est. (err) | Protein g (err) | Carbs g (err) | Fat g (err) |',
  '|---|---|---|---|---|---|---|',
  ...scores.map((s) => `| ${s.meal} | ${s.variant} | ${s.truthG} → ${s.estimateG} g | ${s.truth.kcal} → ${s.estimate.kcal} (${pct(s.errorPct.kcal)}) | ${s.truth.protein} → ${s.estimate.protein} (${pct(s.errorPct.protein)}) | ${s.truth.carbs} → ${s.estimate.carbs} (${pct(s.errorPct.carbs)}) | ${s.truth.fat} → ${s.estimate.fat} (${pct(s.errorPct.fat)}) |`),
  '',
  '**Notes.**',
  '- Garnish (bean sprouts, onion, herbs) is priced with one representative entry (mung bean sprouts); an approximation, small in absolute terms. `beef-cuts` (meal 003) uses the cooked-beef entry.',
  '- The `app-pipeline-run` row prices the recorded Spark per-item likely grams (`data/samples/pho-meal005/spark.json`) with these entries; it is not the app\'s own recorded nutrient output.',
  '- Selection is rank-by-name-match, skipping form-flagged candidates (dry, concentrate, bouillon). Runners-up per entry are in the generated `web/nutrient-scoring.json` input log below the table in the script output, not here.',
  '',
].join('\n');

const docUrl = url('../BENCHMARK.md');
let doc = readFileSync(docUrl, 'utf8');
const at = doc.indexOf('## Nutrient-level scoring');
if (at >= 0) {
  const next = doc.indexOf('\n## ', at + 1);
  doc = doc.slice(0, at) + (next >= 0 ? doc.slice(next + 1) : '');
}
writeFileSync(docUrl, `${doc.trimEnd()}\n\n${section}`);

for (const s of scores) console.log(`${s.meal} ${s.variant}: ` + KEYS.map((k) => `${k} ${s.truth[k]}→${s.estimate[k]} (${pct(s.errorPct[k])})`).join(', '));
console.log(warnings.length ? `\n${warnings.length} TRAP WARNING(S):\n- ${warnings.join('\n- ')}` : '\ntrap checks: all passed');
console.log('next: node scripts/build-benchmark.mjs   (merges web/nutrient-scoring.json into web/benchmark.json)');
