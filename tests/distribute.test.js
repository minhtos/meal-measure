// Multi-item scale distribution (docs/INTEGRATION.md section 8): unit level, mock mode, no network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntry, applyAnchor, attachScaleReading, confirmScale, resolveScaleDecision, applyScaleDistribution,
  logEntry, ScaleDecisionPendingError, UnconfirmedScaleReadingError,
} from '../src/pipeline/measure.js';

before(() => {
  delete process.env.META_API_KEY;
  delete process.env.USDA_API_KEY;
  process.env.MEAL_MEASURE_MODE = 'mock';
});

const reading = (value, unit = 'g') => ({ status: 'unconfirmed', rawText: String(value), value, unit, secondary: null });
const mid = (i) => Math.round((i.portion.photoEstimate.low + i.portion.photoEstimate.high) / 2);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
async function bowl() {
  const e = await buildEntry('fixture:beef-rice-bowl');
  assert.ok(e.items.length >= 2 && e.items.every((i) => i.portion.photoEstimate));
  return e;
}
const confirmed = (e, value, unit) => confirmScale(attachScaleReading(e, reading(value, unit)), reading(value, unit));

test('distribution: shares follow range middles, sum to the total, tagged scale-distributed / medium', async () => {
  const e0 = await bowl();
  const mids = e0.items.map(mid);
  const total = Math.round(sum(mids) * 1.1) + 1; // plausible, deliberately not a multiple of anything
  const e1 = confirmed(e0, total);
  assert.equal(e1.scale.decision, 'not-required');
  assert.equal(e1.scale.itemIds.length, e0.items.length);
  const e2 = applyScaleDistribution(e1);

  assert.equal(sum(e2.items.map((i) => i.portion.loggedGrams)), total, 'shares add up to the total');
  e2.items.forEach((i, k) => {
    const exact = (total * mids[k]) / sum(mids);
    assert.ok(Math.abs(i.portion.loggedGrams - exact) < 1, `${i.food.name} within a gram of its proportional share`);
    assert.deepEqual(i.portion.grams, { low: i.portion.loggedGrams, likely: i.portion.loggedGrams, high: i.portion.loggedGrams }, 'range collapses');
    assert.equal(i.portion.source, 'scale-distributed');
    assert.equal(i.portion.confidence, 'medium');
    assert.deepEqual(i.portion.photoEstimate, e0.items[k].portion.photoEstimate, 'photo range kept');
    assert.equal(i.nutrients.kcal.likely, Math.round(((i.per100g.kcal * i.portion.loggedGrams) / 100) * 10) / 10, 'repriced from the new grams');
    assert.equal(i.nutrients.kcal.low, i.nutrients.kcal.high);
  });
  const logged = logEntry(e2);
  assert.ok(logged.items.every((i) => i.portion.source === 'scale-distributed' && i.portion.confidence === 'medium'));
  assert.equal(e0.items[0].portion.source, 'photo-estimate', 'input entry untouched');
});

test('distribution: rounding stays exact for awkward totals', async () => {
  const e0 = await bowl();
  for (const total of [7, 100.4, 333.3, 612]) {
    const e1 = confirmed(e0, sum(e0.items.map(mid)));
    e1.scale = { ...e1.scale, grams: total, decision: 'use-scale' }; // force the gate open to test the math alone
    const e2 = applyScaleDistribution(e1);
    assert.equal(sum(e2.items.map((i) => i.portion.loggedGrams)), Math.round(total));
  }
});

test('divergence: an implausible total is surfaced, nothing is distributed until the user chooses', async () => {
  const e0 = await bowl();
  const lo = sum(e0.items.map((i) => i.portion.photoEstimate.low));
  const hi = sum(e0.items.map((i) => i.portion.photoEstimate.high));
  const e1 = confirmed(e0, Math.ceil(hi * 1.33) + 50);
  assert.equal(e1.scale.decision, 'pending');
  const w = e1.warnings.find((x) => x.code === 'scale-divergence');
  assert.deepEqual(w.photoRange, { low: lo, high: hi });
  assert.equal(w.scaleGrams, e1.scale.grams);
  assert.ok(w.reasoning.length > 0);
  assert.throws(() => applyScaleDistribution(e1), ScaleDecisionPendingError);
  assert.throws(() => logEntry(e1), ScaleDecisionPendingError);
  assert.ok(e1.items.every((i) => i.portion.source === 'photo-estimate'), 'nothing applied');

  const keep = resolveScaleDecision(e1, 'use-photo');
  assert.throws(() => applyScaleDistribution(keep), /not applying the scale/);
  const use = applyScaleDistribution(resolveScaleDecision(e1, 'use-scale'));
  assert.equal(sum(use.items.map((i) => i.portion.loggedGrams)), Math.round(e1.scale.grams));
  assert.ok(use.items.every((i) => i.portion.source === 'scale-distributed'));
});

test('distribution: needs a confirmed reading and 2+ items; one item keeps the scale-confirmed anchor', async () => {
  const e0 = await bowl();
  assert.throws(() => applyScaleDistribution(attachScaleReading(e0, reading(300))), UnconfirmedScaleReadingError);

  const one = confirmScale(attachScaleReading(e0, reading(150)), reading(150), { itemIds: ['i1'] });
  assert.equal(one.scale.decision, 'not-required');
  assert.throws(() => applyScaleDistribution(one), /2\+ items/);
  const anchored = applyAnchor(one, 'i1', one.scale.grams, 'scale-confirmed');
  const i = anchored.items.find((x) => x.itemId === 'i1');
  assert.equal(i.portion.source, 'scale-confirmed');
  assert.equal(i.portion.confidence, 'high');
  assert.equal(anchored.items.find((x) => x.itemId !== 'i1').portion.source, 'photo-estimate', 'others untouched');
  // an anchor still refuses a multi-item reading: distribution is the only whole-meal path
  const whole = confirmed(e0, Math.round(sum(e0.items.map(mid))));
  assert.throws(() => applyAnchor(whole, 'i1', whole.scale.grams, 'scale-confirmed'), /exactly its one covered item/);
});
