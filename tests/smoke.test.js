// Smoke tests: mock mode, no keys, no network (docs/INTEGRATION.md §11).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { computeNutrients } from '../src/nutrition/nutrients.js';
import { searchFoods, NoUsdaKeyError } from '../src/nutrition/usda.js';
import { lookupFixture } from '../src/nutrition/fixtures.js';
import { readScale } from '../src/model/scaleOcr.js';
import {
  buildEntry, applyCorrection, applyAnchor, attachScaleReading, confirmScale, resolveScaleDecision,
  logEntry, toGrams, UnconfirmedScaleReadingError, ScaleDecisionPendingError,
} from '../src/pipeline/measure.js';

before(() => {
  delete process.env.META_API_KEY;
  delete process.env.USDA_API_KEY;
  process.env.MEAL_MEASURE_MODE = 'mock';
});

const BOWL = 'fixture:beef-rice-bowl';
const beef = (entry) => entry.items.find((i) => i.itemId === 'i1');

test('(1) correction beef -> turkey changes nutrients and logged food name, same portion', async () => {
  const e1 = await buildEntry(BOWL);
  const e2 = await applyCorrection(e1, 'i1', 'ground turkey breast');
  assert.equal(beef(e1).food.name, 'ground beef 90/10');
  assert.equal(beef(e2).food.name, 'ground turkey breast');
  assert.equal(beef(e2).food.source, 'user-corrected');
  assert.equal(beef(e2).food.originalModelName, 'ground beef 90/10');
  assert.equal(beef(e2).portion.loggedGrams, beef(e1).portion.loggedGrams);
  assert.notEqual(beef(e2).nutrients.kcal.likely, beef(e1).nutrients.kcal.likely);
  assert.equal(beef(e2).nutrients.kcal.likely, (120 * 135) / 100);
  const logged = logEntry(e2);
  assert.equal(logged.items[0].food.name, 'ground turkey breast');
  assert.equal(logged.items[0].logged.kcal, 162);
});

test('(2) anchor override changes grams + nutrients and raises confidence to high', async () => {
  const e1 = await buildEntry(BOWL);
  const e2 = applyAnchor(e1, 'i1', 250, 'user-entered');
  assert.equal(beef(e1).portion.confidence, 'low');
  assert.equal(beef(e2).portion.loggedGrams, 250);
  assert.equal(beef(e2).portion.source, 'user-entered');
  assert.equal(beef(e2).portion.confidence, 'high');
  assert.deepEqual(beef(e2).portion.photoEstimate, { low: 100, high: 170 });
  assert.equal(beef(e2).nutrients.kcal.likely, 440);
  assert.equal(beef(e2).nutrients.kcal.low, beef(e2).nutrients.kcal.high);
});

test('(3) unconfirmed scale reading cannot be logged or anchored; can after confirmScale', async () => {
  const e0 = await buildEntry('fixture:rice-only');
  const reading = await readScale('fixture:scale-180g');
  assert.equal(reading.status, 'unconfirmed'); // model claimed "confirmed"; ignored
  const e1 = attachScaleReading(e0, reading);
  assert.throws(() => logEntry(e1), UnconfirmedScaleReadingError);
  assert.throws(() => applyAnchor(e1, 'i1', 180, 'scale-confirmed'), UnconfirmedScaleReadingError);

  const e2 = confirmScale(e1, reading);
  assert.equal(e2.scale.decision, 'not-required'); // 180 g is inside 0.75*120 .. 1.33*210
  const e3 = applyAnchor(e2, 'i1', e2.scale.grams, 'scale-confirmed');
  const logged = logEntry(e3);
  assert.equal(logged.items[0].portion.source, 'scale-confirmed');
  assert.equal(logged.items[0].portion.loggedGrams, 180);
  assert.equal(logged.items[0].portion.confidence, 'high');
});

test('(4) logged values are range middles; every item carries source + confidence', async () => {
  const logged = logEntry(await buildEntry(BOWL));
  const [b, r] = logged.items;
  assert.equal(b.portion.loggedGrams, 135); // round((100+170)/2)
  assert.equal(r.portion.loggedGrams, 165); // round((120+210)/2)
  for (const i of logged.items) {
    assert.equal(i.logged.kcal, i.nutrients.kcal.likely);
    assert.ok(i.portion.source && i.portion.confidence);
    assert.ok(i.food.source && i.food.identificationConfidence !== undefined);
    assert.ok(i.nutrientSource.db && i.nutrientSource.id);
  }
  const range = computeNutrients(lookupFixture('white rice').per100g, { low: 120, high: 210 });
  assert.deepEqual(r.nutrients, range);
});

test('poisoned spark output: nutrient-like fields never reach the entry', async () => {
  const entry = await buildEntry('fixture:poisoned');
  assert.equal(entry.provenance.strippedNutrientFields, true);
  const text = JSON.stringify(entry);
  for (const bad of ['9999', 'calories', 'totalCalories']) assert.ok(!text.includes(bad), bad);
  assert.equal(entry.items[0].nutrients.kcal.likely, 237.6); // 176 kcal/100g × 135 g, from the table
});

test('mask-less item is a supported state and logs normally', async () => {
  const e = await buildEntry(BOWL);
  assert.equal(beef(e).portion.mask, 'present');
  const rice = e.items.find((i) => i.itemId === 'i2');
  assert.equal(rice.mask, null);
  assert.equal(rice.portion.mask, 'none');
  assert.equal(logEntry(e).items[1].portion.mask, 'none');
});

test('implausible confirmed scale total carries a tare warning and blocks logging until the user decides', async () => {
  const e0 = await buildEntry(BOWL);
  const reading = await readScale('fixture:scale-612g');
  const e1 = confirmScale(attachScaleReading(e0, reading), reading);
  assert.equal(e1.scale.decision, 'pending');
  const w = e1.warnings.find((x) => x.code === 'scale-divergence');
  assert.match(w.tareHint, /tare/);
  assert.throws(() => logEntry(e1), ScaleDecisionPendingError);
  assert.doesNotThrow(() => logEntry(resolveScaleDecision(e1, 'use-photo')));
});

test('toGrams converts in code; volume refused', () => {
  assert.equal(toGrams(0.352, 'kg'), 352);
  assert.equal(toGrams(1, 'lb'), 453.6);
  assert.equal(toGrams(12, 'oz'), 340.2);
  assert.equal(toGrams(1, 'lb_oz', { value: 4.2, unit: 'oz' }), 572.7);
  assert.throws(() => toGrams(250, 'ml'));
  assert.throws(() => toGrams(-1, 'g'));
});

test('usda search without a key throws a catchable "no key in env" error', async () => {
  await assert.rejects(() => searchFoods('rice', { env: {} }), (err) => err instanceof NoUsdaKeyError && /no key in env/.test(err.message));
});
