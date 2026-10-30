// Near-miss match candidates + reselection (docs/INTEGRATION.md §6.1). Mock
// tests use the fixture table; the live test stubs one fetch for Spark, SAM and USDA.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreMatch, formConcern, nearMissReasons, rankCandidates } from '../src/nutrition/match.js';
import { buildEntry, applyCorrection, selectMatchCandidate, logEntry } from '../src/pipeline/measure.js';

before(() => {
  delete process.env.META_API_KEY;
  delete process.env.USDA_API_KEY;
  process.env.MEAL_MEASURE_MODE = 'mock';
});

const BROTH = 'fixture:broth-near-miss';
const item = (entry) => entry.items[0];

test('(i) near-miss fixture: five-or-fewer scored candidates, ordered, nearMiss with reasons', async () => {
  const it = item(await buildEntry(BROTH));
  assert.ok(it.matchCandidates.length >= 2 && it.matchCandidates.length <= 5);
  const scores = it.matchCandidates.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  for (const c of it.matchCandidates) {
    assert.ok(c.db && c.id && c.name && c.dataType && c.candidateId);
    assert.deepEqual(Object.keys(c.per100g).sort(), ['carbs', 'fat', 'kcal', 'protein']);
  }
  assert.equal(it.nearMiss, true);
  assert.deepEqual(it.nearMissReasons, ['close-scores', 'form-concern']); // 0.667 vs 0.571, and the winner is the dry bouillon
  assert.equal(it.matchCandidates[0].name, 'chicken broth, dry bouillon');
  assert.equal(it.matchCandidates[0].formConcern, 'dry');
  assert.equal(it.nutrientSource.id, it.matchCandidates[0].id);
  // Spark's alternatives ride along on the same item.
  assert.deepEqual(it.alternatives, [{ name: 'chicken stock', confidence: 0.12 }]);
});

test('(ii) clear winner: nearMiss false, no reasons', async () => {
  const it = item(await buildEntry('fixture:rice-only'));
  assert.equal(it.nearMiss, false);
  assert.deepEqual(it.nearMissReasons, []);
  assert.equal(it.matchCandidates[0].name, 'white rice, cooked');
  assert.ok(it.matchCandidates[0].score >= 0.99);
});

test('(iii) selectMatchCandidate swaps source + nutrients at the same grams; original kept', async () => {
  const e1 = await buildEntry(BROTH);
  const rts = item(e1).matchCandidates.find((c) => c.id === 'fixture:chicken-broth-rts');
  const e2 = selectMatchCandidate(e1, 'i1', rts.candidateId);
  assert.notEqual(item(e2).nutrientSource.id, item(e1).nutrientSource.id);
  assert.equal(item(e2).nutrientSource.id, 'fixture:chicken-broth-rts');
  assert.equal(item(e2).portion.loggedGrams, item(e1).portion.loggedGrams);
  assert.deepEqual(item(e2).portion.grams, item(e1).portion.grams);
  assert.equal(item(e1).nutrients.kcal.likely, 235 * 2.5); // dry bouillon at 250 g
  assert.equal(item(e2).nutrients.kcal.likely, 7 * 2.5);
  assert.equal(item(e2).food.source, 'user-corrected');
  assert.equal(item(e2).food.originalModelName, 'chicken broth');
  assert.equal(item(e2).nearMiss, false);
  assert.equal(item(e2).provenance.originalNutrientSource.id, 'fixture:chicken-broth-dry');
  assert.deepEqual(item(e2).matchCandidates, item(e1).matchCandidates); // list untouched, can pick again
  assert.equal(item(e1).nutrientSource.id, 'fixture:chicken-broth-dry'); // input not mutated
  const logged = logEntry(e2);
  assert.equal(logged.items[0].nutrientSource.id, 'fixture:chicken-broth-rts');
  assert.equal(logged.items[0].originalNutrientSource.id, 'fixture:chicken-broth-dry');
  assert.throws(() => selectMatchCandidate(e1, 'i1', 'fixture:nope'), /no match candidate/);
});

test('a typed correction refreshes the candidates for the new name and keeps the original source', async () => {
  const e1 = await buildEntry(BROTH);
  const e2 = await applyCorrection(e1, 'i1', 'cooked white rice');
  assert.equal(item(e2).matchCandidates[0].name, 'white rice, cooked');
  assert.equal(item(e2).nearMiss, false);
  assert.equal(item(e2).provenance.originalNutrientSource.id, 'fixture:chicken-broth-dry');
});

test('near-miss rule: each trigger on its own, and a clear winner', () => {
  const c = (score, formConcern = null) => ({ score, formConcern });
  assert.deepEqual(nearMissReasons([c(0.9), c(0.5)], 0.8), []);
  assert.deepEqual(nearMissReasons([c(0.9), c(0.77)], 0.8), ['close-scores']); // gap 0.13 <= 0.135
  assert.deepEqual(nearMissReasons([c(0.9), c(0.76)], 0.8), []); // gap 0.14 > 0.135
  assert.deepEqual(nearMissReasons([c(0.4), c(0.1)], 0.8), ['low-score']);
  assert.deepEqual(nearMissReasons([c(0.9), c(0.5)], 0.49), ['low-identification-confidence']);
  assert.deepEqual(nearMissReasons([c(0.9), c(0.5)], 'confirmed'), []);
  assert.deepEqual(nearMissReasons([c(0.9, 'dry'), c(0.5)], 0.8), ['form-concern']);
  assert.deepEqual(nearMissReasons([c(0.9)], 0.8), []); // a lone candidate has no rival
  assert.deepEqual(nearMissReasons([], 0.8), []);
});

test('scoring and form sanity: dry bouillon vs broth, and stable ordering', () => {
  assert.equal(scoreMatch('white rice cooked', 'White rice, cooked'), 1);
  assert.equal(formConcern('chicken broth', 'Soup, chicken broth cubes'), 'cube');
  assert.equal(formConcern('chicken bouillon', 'chicken bouillon, dry'), 'dry'); // 'bouillon' is in the query, 'dry' is not
  assert.equal(formConcern('chicken broth', 'chicken broth, ready-to-serve'), null);
  const row = (id, name) => ({ db: 'x', id, name, dataType: 't', per100g: { kcal: 1, protein: 1, carbs: 1, fat: 1 } });
  const ranked = rankCandidates('oat', [row('a', 'oat'), row('b', 'oat'), row('c', 'x1'), row('d', 'x2'), row('e', 'x3'), row('f', 'x4')]);
  assert.deepEqual(ranked.map((r) => r.id), ['a', 'b', 'c', 'd', 'e']); // ties keep database order; capped at five
});

// ---- (iv) live path: one stubbed fetch for Spark, SAM and USDA FDC ----
const jpeg = Buffer.from('ffd8' + 'ffe10008457869660000' + 'ffc0000b08' + '01e0' + '0280' + '01' + '011100' + 'ffda0002ffd9', 'hex');
const dir = mkdtempSync(join(tmpdir(), 'mm-cand-'));
const photoPath = join(dir, 'p.jpg');
writeFileSync(photoPath, jpeg);

const reply = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': 'req-1' }), json: async () => body });
const fdc = (id, description, kcal, protein, carbs, fat) => ({
  fdcId: id, description, dataType: 'SR Legacy',
  foodNutrients: [[208, kcal], [203, protein], [205, carbs], [204, fat]].map(([n, value]) => ({ nutrientNumber: String(n), value })),
});

test('(iv) live path carries matchCandidates, nearMiss, alternatives; select works on it', async () => {
  const sparkJson = '{"items":[{"name":"chicken broth","alternatives":[{"name":"chicken stock","confidence":0.1}],"grams":{"low":200,"likely":250,"high":300},"confidence":0.8}],"context":{"container":{"type":"bowl","confidence":0.9}}}';
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('chat/completions')) return reply({ model: 'muse-spark-1.3', choices: [{ message: { content: sparkJson } }] });
    if (url.includes('/v1/responses')) return reply({ model: 'sam-3.1', output: [{ content: [{ text: '' }] }] });
    return reply({
      foods: [
        fdc(1, 'Soup, chicken broth, ready-to-serve', 7, 1.1, 0.4, 0.2),
        fdc(2, 'Soup, chicken broth, dry bouillon', 235, 6.4, 27, 9.5),
        fdc(3, 'Soup, chicken broth cubes, dry', 237, 7, 26, 9),
      ],
    });
  };
  const env = { META_API_KEY: 'k', MEAL_MEASURE_MODE: 'live', USDA_API_KEY: 'u' };
  const opts = { env, fetchImpl, cacheDir: join(dir, 'usda-cache') };
  const e1 = await buildEntry(photoPath, opts);
  assert.ok(urls.some((u) => u.includes('fdc')), 'USDA was searched');
  const it = item(e1);
  assert.deepEqual(it.matchCandidates.map((c) => c.id), ['2', '3', '1']); // 0.571, 0.571 (database order breaks the tie), 0.5
  assert.ok(it.matchCandidates.every((c) => c.db === 'usda-fdc' && c.dataType === 'SR Legacy'));
  assert.equal(it.nearMiss, true);
  assert.deepEqual(it.alternatives, [{ name: 'chicken stock', confidence: 0.1 }]);
  assert.equal(it.nutrientSource.db, 'usda-fdc');
  const e2 = selectMatchCandidate(e1, 'i1', 'usda-fdc:1');
  assert.equal(item(e2).nutrientSource.id, '1');
  assert.equal(item(e2).portion.loggedGrams, item(e1).portion.loggedGrams);
  assert.equal(item(e2).nutrients.kcal.likely, 17.5);
});
