// FIXTURE: tests/fixtures/off-sample.csv is a tiny hand-made OFF-style export
// (real US product codes, approximate values) — not real OFF data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { importOff } from '../scripts/import-off.mjs';
import { resolveUpc } from '../src/pipeline/barcode.js';

const FIXTURE = new URL('./fixtures/off-sample.csv', import.meta.url).pathname;
let dataDir;
const noKey = { env: {} };
const noNetwork = () => assert.fail('network must not be used in tests');

before(async () => {
  dataDir = await mkdtemp(`${tmpdir()}/off-test-`);
  await importOff(FIXTURE, dataDir);
});
after(() => rm(dataDir, { recursive: true, force: true }));

test('import keeps only usable US products', async () => {
  const index = JSON.parse(await readFile(`${dataDir}/off-us.index.json`, 'utf8'));
  assert.deepEqual(Object.keys(index).sort(), ['0044000032029', '0049000028911', '013000006408', '016000275287']);
  const oreo = await resolveUpc('044000032029', { dataDir, ...noKey, fetch: noNetwork });
  assert.equal(oreo.per100g.kcal, 479.9); // kJ-only row: 2008 / 4.184
});

test('fixture UPC resolves via off-local with computed nutrients', async () => {
  const r = await resolveUpc('0049000028911', { dataDir, grams: 355, ...noKey, fetch: noNetwork });
  assert.equal(r.status, 'matched');
  assert.equal(r.source, 'off-local');
  assert.equal(r.product.name, 'Coca-Cola Classic');
  assert.equal(r.nutrients.kcal.likely, 149.1); // 42 × 355 / 100
});

test('code normalization: 12-digit matches 13-digit stored, GTIN-14 matches 12-digit stored', async () => {
  const a = await resolveUpc('049000028911', { dataDir, ...noKey });
  assert.equal(a.status, 'matched');
  const b = await resolveUpc('00013000006408', { dataDir, ...noKey });
  assert.equal(b.product.name, 'Tomato Ketchup');
});

test('unknown code returns unmatched; missing USDA key does not crash', async () => {
  const r = await resolveUpc('012345678905', { dataDir, ...noKey, fetch: noNetwork });
  assert.deepEqual(r, { status: 'unmatched', code: '012345678905' });
});

test('USDA fallback: match, miss, and HTTP failure stay distinct', async () => {
  const env = { USDA_API_KEY: 'test-key' };
  const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  const food = {
    fdcId: 1, description: 'TEST BAR', brandOwner: 'Acme', gtinUpc: '099999999991', servingSize: 40, servingSizeUnit: 'g',
    foodNutrients: [{ nutrientNumber: '208', value: 400 }, { nutrientNumber: '203', value: 10 }, { nutrientNumber: '205', value: 50 }, { nutrientNumber: '204', value: 15 }],
  };
  const hit = await resolveUpc('099999999991', { dataDir, env, fetch: reply(200, { foods: [food] }) });
  assert.equal(hit.source, 'usda-branded');
  assert.equal(hit.nutrients.kcal.likely, 160); // 400 × 40 / 100
  const miss = await resolveUpc('099999999991', { dataDir, env, fetch: reply(200, { foods: [] }) });
  assert.equal(miss.status, 'unmatched');
  const limited = await resolveUpc('099999999991', { dataDir, env, fetch: reply(429, {}) });
  assert.equal(limited.status, 'lookup-failed');
  assert.match(limited.reason, /429/);
});
