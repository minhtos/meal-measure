// App surface part 2: correction sheet, scale-confirm, mock replay, barcode, quick meals, benchmark.
// Drives server.mjs over HTTP in mock mode (recorded samples; no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { buildEntry, replayRecordedNutrients, recordedNutrients, logEntry } from '../src/pipeline/measure.js';

const NO_KEY = { PATH: process.env.PATH };

async function start(opts = {}) {
  const server = createApp({ env: NO_KEY, ...opts });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  return { base, post, get, close: () => new Promise((ok) => server.close(ok)) };
}
const measure = async (app, sample) => (await app.post('/api/measure', { sample })).body;
const item = (view, id) => view.items.find((i) => i.itemId === id);

// ---- mock replay ----
test('mock measure replays recorded runs: no recorded nutrients means "not computed", never fixture numbers', async () => {
  const app = await start();
  try {
    for (const sample of ['tacos-meal004', 'pho-meal005']) {
      const m = await measure(app, sample);
      assert.ok(m.items.length > 0);
      for (const i of m.items) {
        assert.equal(i.notComputedInRecordedRun, true, `${sample} ${i.name}`);
        assert.equal(i.nutrients, null);
        assert.deepEqual(i.matchCandidates, []);
        assert.equal(i.nearMiss, false);
      }
      const log = await app.post('/api/log', { sessionId: m.sessionId });
      assert.equal(log.status, 409);
      assert.match(log.body.error, /not computed in the recorded run/);
    }
  } finally { await app.close(); }
});

test('replayRecordedNutrients: recorded numbers carry through unchanged; the rest is excluded from a log', async () => {
  const env = { MEAL_MEASURE_MODE: 'mock' };
  const live = await buildEntry('fixture:beef-rice-bowl', { env });
  const [first, ...rest] = live.items;
  // TEST DATA standing in for a recorded run: recognisably not a database value.
  const recorded = { items: { [first.itemId]: { ...recordedNutrients(live).items[first.itemId], per100g: { kcal: 111, protein: 1, carbs: 2, fat: 3 } } } };
  recorded.items[first.itemId].nutrients = { kcal: { low: 1, likely: 2, high: 3 }, protein: { low: 1, likely: 1, high: 1 }, carbs: { low: 1, likely: 1, high: 1 }, fat: { low: 1, likely: 1, high: 1 } };
  const replayed = replayRecordedNutrients(live, recorded);
  assert.deepEqual(replayed.items[0].nutrients, recorded.items[first.itemId].nutrients);
  assert.deepEqual(replayed.items[0].per100g, recorded.items[first.itemId].per100g);
  for (const i of replayed.items.slice(1)) {
    assert.equal(i.notComputedInRecordedRun, true);
    assert.equal(i.nutrients, null);
  }
  assert.equal(rest.length, replayed.items.length - 1);
  assert.throws(() => logEntry(replayed), /not computed in the recorded run/);
  const logged = logEntry({ ...replayed, items: [replayed.items[0]] });
  assert.equal(logged.items[0].logged.kcal, 2);
});

// ---- correction sheet endpoints (tacos session) ----
test('tacos session: correct -> select-candidate -> correct grams, each recomputed at the same portion', async () => {
  const app = await start();
  try {
    const m = await measure(app, 'tacos-meal004');
    const sid = m.sessionId;
    const before = item(m, 'i1');

    // a typed / look-alike rename: the fixture database prices it (mock), and offers candidates
    const renamed = (await app.post('/api/correct', { sessionId: sid, itemId: 'i1', name: 'white rice' })).body;
    const r1 = item(renamed, 'i1');
    assert.equal(r1.name, 'white rice');
    assert.equal(r1.corrected, true);
    assert.equal(r1.foodSource, 'user-corrected');
    assert.deepEqual(r1.grams, before.grams, 'same portion');
    assert.ok(r1.nutrients.kcal.likely > 0);
    assert.ok(r1.matchCandidates.length >= 2);
    assert.ok(r1.matchCandidates.every((c) => typeof c.name === 'string' && typeof c.kcalPer100g === 'number'));
    assert.equal(renamed.items.filter((i) => i.notComputedInRecordedRun).length, m.items.length - 1);

    // pick another candidate from the dropdown: name, nutrients and provenance follow, portion does not move
    const other = r1.matchCandidates.find((c) => `${r1.nutrientSource.db}:${r1.nutrientSource.id}` !== c.candidateId);
    const picked = (await app.post('/api/select-candidate', { sessionId: sid, itemId: 'i1', candidateId: other.candidateId })).body;
    const r2 = item(picked, 'i1');
    assert.equal(r2.name, other.name);
    assert.deepEqual(r2.grams, before.grams);
    assert.equal(`${r2.nutrientSource.db}:${r2.nutrientSource.id}`, other.candidateId);
    assert.deepEqual(r2.originalNutrientSource, r1.originalNutrientSource, 'the first match stays in provenance');
    assert.notDeepEqual(r2.nutrients, r1.nutrients);
    assert.equal(r2.nearMiss, false);

    // gram editor: instant recompute of nutrients + the range collapses to the entered value
    const edited = (await app.post('/api/correct', { sessionId: sid, itemId: 'i1', grams: 200 })).body;
    const r3 = item(edited, 'i1');
    assert.deepEqual(r3.grams, { low: 200, likely: 200, high: 200 });
    assert.equal(r3.portionSource, 'user-entered');
    assert.equal(r3.portionConfidence, 'high');
    assert.ok(Math.abs(r3.nutrients.kcal.likely - other.kcalPer100g * 2) <= 1);
    assert.equal(r3.name, other.name);

    // validation
    const bad = (body) => app.post('/api/correct', { sessionId: sid, itemId: 'i1', ...body });
    assert.equal((await bad({})).status, 400);
    assert.equal((await bad({ name: '   ' })).status, 400);
    assert.equal((await bad({ grams: -3 })).status, 400);
    assert.equal((await app.post('/api/correct', { sessionId: sid, itemId: 'nope', grams: 5 })).status, 400);
    assert.equal((await app.post('/api/select-candidate', { sessionId: sid, itemId: 'i1', candidateId: 'fixture:nope' })).status, 400);
    assert.equal((await app.post('/api/select-candidate', { sessionId: 'unknown', itemId: 'i1', candidateId: 'x' })).status, 404);

    // log: the priced item goes in, the unpriced recorded items are left out with the reason
    const logged = await app.post('/api/log', { sessionId: sid, day: '2026-10-30' });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.entry.items.length, 1);
    assert.equal(logged.body.excluded.length, m.items.length - 1);
    assert.ok(logged.body.excluded.every((e) => e.reason === 'not computed in the recorded run'));
    assert.equal(logged.body.entry.items[0].tags.food, 'corrected');
  } finally { await app.close(); }
});

test('refine endpoint in mock mode falls back: previous outline kept, failure reported', async () => {
  const app = await start();
  try {
    const m = await measure(app, 'tacos-meal004');
    const masked = m.items.find((i) => i.mask);
    const points = [{ x: 0.45, y: 0.45, label: 1 }, { x: 0.1, y: 0.1, label: 0 }];
    const r = await app.post('/api/refine', { sessionId: m.sessionId, itemId: masked.itemId, points });
    assert.equal(r.status, 200);
    assert.equal(r.body.refine.ok, false);
    assert.equal(r.body.refine.reason, 'mock_mode');
    assert.deepEqual(item(r.body, masked.itemId).mask, masked.mask, 'the outline is exactly the previous one');
    const w = r.body.warnings.find((x) => x.code === 'mask-refine-failed' && x.itemId === masked.itemId);
    assert.match(w.message, /kept the previous one/);
    assert.deepEqual(item(r.body, masked.itemId).maskPoints, [], 'a failed tap is not remembered');

    const bad = (body) => app.post('/api/refine', { sessionId: m.sessionId, itemId: masked.itemId, ...body });
    assert.equal((await bad({ points: [{ x: 2, y: 0.5, label: 1 }] })).status, 400);
    assert.equal((await bad({ points: [{ x: 0.5, y: 0.5, label: 2 }] })).status, 400);
    assert.equal((await bad({ points: [] })).status, 400);
    assert.equal((await app.post('/api/refine', { sessionId: m.sessionId, itemId: 'nope', points })).status, 400);
  } finally { await app.close(); }
});

// ---- scale confirmation (pho sample carries a recorded, unconfirmed reading) ----
async function phoWithReading(app) {
  const m = await measure(app, 'pho-meal005');
  const ocr = await app.post('/api/scale-ocr', { sessionId: m.sessionId });
  assert.equal(ocr.body.entry.scale.status, 'unconfirmed');
  const it = m.items.find((i) => i.photoEstimate);
  return { sid: m.sessionId, it, raw: ocr.body.entry.scale };
}

test('scale-confirm: needs a reading, an item, a real unit; a plausible total anchors that item', async () => {
  const app = await start();
  try {
    const t = await measure(app, 'tacos-meal004'); // no reading attached
    assert.equal((await app.post('/api/scale-confirm', { sessionId: t.sessionId, itemId: 'i1', value: 5, unit: 'g' })).status, 409);

    const { sid, it, raw } = await phoWithReading(app);
    assert.equal(raw.rawText, '595.4');
    const send = (body) => app.post('/api/scale-confirm', { sessionId: sid, ...body });
    assert.equal((await send({ value: 100, unit: 'g' })).status, 400, 'several items: say which one');
    assert.equal((await send({ itemId: it.itemId, value: 100, unit: 'stone' })).status, 400);
    assert.equal((await send({ itemId: it.itemId, value: -1, unit: 'g' })).status, 400);
    assert.equal((await send({ decision: 'use-scale' })).status, 409, 'nothing to decide yet');
    assert.equal((await app.post('/api/log', { sessionId: sid })).status, 409, 'still unconfirmed');

    const ok = await send({ itemId: it.itemId, value: it.grams.likely, unit: 'g' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.scale.status, 'confirmed');
    assert.equal(ok.body.scale.decision, 'not-required');
    assert.equal(ok.body.scale.edited, true, 'differs from the OCR text');
    const a = item(ok.body, it.itemId);
    assert.deepEqual(a.grams, { low: it.grams.likely, likely: it.grams.likely, high: it.grams.likely });
    assert.equal(a.portionSource, 'scale-confirmed');
    assert.equal(a.portionConfidence, 'high');
    assert.deepEqual(a.photoEstimate, it.photoEstimate);
    assert.equal((await send({ itemId: it.itemId, value: 5, unit: 'g' })).status, 409, 'already confirmed');
  } finally { await app.close(); }
});

test('scale-confirm: whole-meal total is distributed over the items; divergence waits; single anchor unchanged', async () => {
  const app = await start();
  try {
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const a = await phoWithReading(app);
    const first = await app.post('/api/scale-confirm', { sessionId: a.sid, mode: 'whole-meal', value: 1, unit: 'g' });
    assert.equal(first.body.scale.decision, 'pending', 'a 1 g total diverges from the photo');
    assert.ok(first.body.scale.itemIds.length >= 2);
    assert.ok(first.body.items.every((i) => i.portionSource === 'photo-estimate'), 'nothing distributed yet');
    assert.equal((await app.post('/api/log', { sessionId: a.sid })).status, 409);

    const mids = first.body.items.map((i) => Math.round((i.photoEstimate.low + i.photoEstimate.high) / 2));
    const total = Math.round(sum(mids) * 1.05);
    const fixed = await app.post('/api/scale-confirm', { sessionId: a.sid, mode: 'whole-meal', value: total, unit: 'g' });
    assert.equal(fixed.body.scale.decision, 'not-required');
    fixed.body.items.forEach((i, k) => {
      assert.equal(i.portionSource, 'scale-distributed');
      assert.equal(i.portionConfidence, 'medium');
      assert.equal(i.grams.low, i.grams.high, 'range bar narrowed');
      assert.ok(Math.abs(i.grams.likely - (total * mids[k]) / sum(mids)) < 1);
    });
    assert.equal(sum(fixed.body.items.map((i) => i.grams.likely)), total);

    // divergence then "use the scale value" distributes
    const b = await phoWithReading(app);
    const d = await app.post('/api/scale-confirm', { sessionId: b.sid, mode: 'whole-meal', value: 5000, unit: 'g' });
    assert.equal(d.body.scale.decision, 'pending');
    const used = await app.post('/api/scale-confirm', { sessionId: b.sid, decision: 'use-scale' });
    assert.ok(used.body.items.every((i) => i.portionSource === 'scale-distributed'));
    assert.equal(sum(used.body.items.map((i) => i.grams.likely)), 5000);

    // the one-item path is as before
    const c = await phoWithReading(app);
    const one = await app.post('/api/scale-confirm', { sessionId: c.sid, itemId: c.it.itemId, value: c.it.grams.likely, unit: 'g' });
    assert.equal(item(one.body, c.it.itemId).portionSource, 'scale-confirmed');
    assert.ok(one.body.items.filter((i) => i.itemId !== c.it.itemId).every((i) => i.portionSource === 'photo-estimate'));
  } finally { await app.close(); }
});

test('scale-confirm: divergence shows both values with reasoning and waits for the user', async () => {
  const app = await start();
  try {
    // the oz/g hazard: "10.6" read as grams, but 10.6 oz would fit the photo
    const a = await phoWithReading(app);
    const L = a.it.grams.likely;
    const asGrams = Math.round((L / 28.349523125) * 10) / 10;
    const d = await app.post('/api/scale-confirm', { sessionId: a.sid, itemId: a.it.itemId, value: asGrams, unit: 'g' });
    assert.equal(d.body.scale.decision, 'pending');
    assert.equal(item(d.body, a.it.itemId).portionSource, 'photo-estimate', 'nothing applied yet');
    const w = d.body.warnings.find((x) => x.code === 'scale-divergence');
    assert.equal(w.scaleGrams, asGrams);
    assert.deepEqual(w.photoRange, a.it.photoEstimate);
    assert.deepEqual(w.options, ['use-scale', 'use-photo', 'enter-grams']);
    assert.ok(w.reasoning.some((r) => /ounces/.test(r)), 'names the unit mix-up');
    assert.equal((await app.post('/api/log', { sessionId: a.sid })).status, 409, 'logging waits for the decision');
    assert.equal((await app.post('/api/scale-confirm', { sessionId: a.sid, decision: 'pick-for-me' })).status, 400);

    // the user fixes the unit: re-confirm (edit) resolves the divergence and anchors
    const fixed = await app.post('/api/scale-confirm', { sessionId: a.sid, itemId: a.it.itemId, value: asGrams, unit: 'oz' });
    assert.equal(fixed.body.scale.decision, 'not-required');
    assert.equal(fixed.body.warnings.some((x) => x.code === 'scale-divergence'), false);
    assert.equal(item(fixed.body, a.it.itemId).portionSource, 'scale-confirmed');

    // choose the scale value anyway
    const b = await phoWithReading(app);
    await app.post('/api/scale-confirm', { sessionId: b.sid, itemId: b.it.itemId, value: 595.4, unit: 'oz' });
    const used = await app.post('/api/scale-confirm', { sessionId: b.sid, decision: 'use-scale' });
    assert.equal(item(used.body, b.it.itemId).portionSource, 'scale-confirmed');
    assert.equal(used.body.scale.decision, 'use-scale');

    // keep the photo estimate
    const c = await phoWithReading(app);
    await app.post('/api/scale-confirm', { sessionId: c.sid, itemId: c.it.itemId, value: 595.4, unit: 'oz' });
    const kept = await app.post('/api/scale-confirm', { sessionId: c.sid, decision: 'use-photo' });
    assert.equal(item(kept.body, c.it.itemId).portionSource, 'photo-estimate');
    assert.deepEqual(item(kept.body, c.it.itemId).grams, c.it.grams);
    assert.equal(kept.body.scale.decision, 'use-photo');
  } finally { await app.close(); }
});

// ---- barcode ----
function offDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mm-off-'));
  const line = `${JSON.stringify({ code: '0000012345670', name: 'Test Bar', brands: 'Acme', per100g: { kcal: 400, protein: 10, carbs: 50, fat: 20 } })}\n`;
  writeFileSync(join(dir, 'off-us.jsonl'), line);
  writeFileSync(join(dir, 'off-us.index.json'), JSON.stringify({ '0000012345670': 0 }));
  return dir;
}

test('barcode (mock mode, local product data): lookup, grams, log; quick meals then offer it again', async () => {
  const app = await start({ offDataDir: offDir() });
  try {
    assert.equal((await app.post('/api/barcode', { code: 'abc' })).status, 400);
    assert.equal((await app.post('/api/barcode', { code: '12345670', grams: 0 })).status, 400);
    assert.equal((await app.post('/api/barcode', { code: '99999999' })).body.status, 'unmatched');

    const found = (await app.post('/api/barcode', { code: '12345670' })).body; // 8 digits: matches the stored 13-digit form
    assert.equal(found.status, 'matched');
    assert.equal(found.name, 'Test Bar (Acme)');
    assert.equal(found.per100g.kcal, 400);
    assert.equal(found.sessionId, undefined, 'no session until grams are entered');

    const m = (await app.post('/api/barcode', { code: '12345670', grams: 50 })).body;
    const it = m.entry.items[0];
    assert.equal(it.nutrients.kcal.likely, 200);
    assert.equal(it.portionSource, 'user-entered');
    assert.equal(it.nutrientSource.db, 'off');
    assert.equal(m.entry.mock, false);

    assert.deepEqual((await app.get('/api/quick-meals')).body.meals, []);
    const logged = await app.post('/api/log', { sessionId: m.sessionId, day: '2026-10-30' });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.entry.items[0].tags.food, 'scanned barcode');

    const { meals } = (await app.get('/api/quick-meals')).body;
    assert.equal(meals.length, 1);
    assert.equal(meals[0].kcal, 200);
    assert.equal(meals[0].items[0].loggedGrams, 50);
    const again = await app.post('/api/quick-meals/log', { quickId: meals[0].quickId, day: '2026-10-30' });
    assert.equal(again.status, 200);
    assert.equal(again.body.day.entries.length, 2);
    assert.equal(again.body.day.totals.kcal.likely, 400);
    assert.equal((await app.get('/api/quick-meals')).body.meals.length, 1, 'same meal, one card');
    assert.equal((await app.post('/api/quick-meals/log', { quickId: 'nope' })).status, 404);
  } finally { await app.close(); }
});

test('barcode with no local product data reports it instead of failing', async () => {
  const app = await start({ offDataDir: join(tmpdir(), 'mm-no-such-dir') });
  try {
    const r = await app.post('/api/barcode', { code: '12345670' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'unavailable');
  } finally { await app.close(); }
});

// ---- benchmark ----
test('benchmark.json parses, is served, and matches BENCHMARK.md', async () => {
  const doc = readFileSync(new URL('../BENCHMARK.md', import.meta.url), 'utf8');
  const b = JSON.parse(readFileSync(new URL('../web/benchmark.json', import.meta.url), 'utf8'));
  // Count only the results table: later sections (e.g. nutrient scoring) repeat meal ids per variant.
  const results = doc.split(/^## Results\b.*$/m)[1].split(/^## /m)[0];
  const rows = [...results.matchAll(/^\|\s*(\d{3})\s*\|/gm)].map((m) => m[1]);
  assert.equal(b.meals.length, rows.length);
  assert.deepEqual(b.meals.map((m) => m.id), rows);
  assert.equal(b.tally.n, rows.length);
  for (const m of b.meals) {
    assert.ok(doc.includes(`${m.truthG} g`) && doc.includes(`${m.estimateG} g`), `meal ${m.id} numbers appear in the document`);
    assert.ok(doc.includes(m.errorLabel), `meal ${m.id} ${m.errorLabel}`);
  }
  assert.deepEqual(b.meals.filter((m) => !m.inRange).map((m) => m.id), ['003', '005'], 'misses are in the data');
  assert.equal(b.scaleDisplay.ab.estimateG, 870);
  assert.equal(b.scaleDisplay.ab.truthG, 846);
  assert.ok(b.samNotes.length >= 2);
  assert.match(b.note, /identification \+ portion error against database-computed truth/);

  const app = await start();
  try {
    const served = await app.get('/benchmark.json');
    assert.equal(served.status, 200);
    assert.deepEqual(served.body, b);
  } finally { await app.close(); }
});
