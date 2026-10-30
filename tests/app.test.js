// App surface smoke test: boots server.mjs on an ephemeral port and drives the HTTP API.
// Mock mode replays the recorded samples; live mode runs against a stubbed transport (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDayLog } from '../src/app/dayLog.js';
import { buildEntry, logEntry } from '../src/pipeline/measure.js';

async function start(opts) {
  const server = createApp(opts);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { base, post, close: () => new Promise((ok) => server.close(ok)) };
}

const NO_KEY = { PATH: process.env.PATH }; // no Meta key => mock mode

test('serves the shell and reports mock mode with no key', async () => {
  const app = await start({ env: NO_KEY });
  try {
    const page = await fetch(`${app.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>meal-measure<\/title>/);
    for (const f of ['/app.js', '/style.css', '/manifest.webmanifest', '/sw.js']) assert.equal((await fetch(app.base + f)).status, 200, f);
    const cfg = await (await fetch(`${app.base}/api/config`)).json();
    assert.equal(cfg.mode, 'mock');
    assert.deepEqual(cfg.samples.map((s) => s.id), ['tacos-meal004', 'pho-meal005']);
    // path traversal stays inside web/
    for (const p of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs']) assert.notEqual((await fetch(app.base + p)).status, 200, p);
  } finally { await app.close(); }
});

test('mock measure: tacos sample items + decoded mask paths, labelled, no raw payloads', async () => {
  const app = await start({ env: NO_KEY });
  try {
    const { status, body } = await app.post('/api/measure', { sample: 'tacos-meal004' });
    assert.equal(status, 200);
    assert.equal(body.mock, true);
    assert.match(body.mockLabel, /mock data/);
    assert.deepEqual(body.items.map((i) => i.name), [
      'corn tortilla', 'seasoned pork (carne enchilada), grilled', 'cilantro, chopped', 'white onion', 'lime wedge', 'green chili pepper, roasted',
    ]);
    const masked = body.items.filter((i) => i.mask);
    assert.ok(masked.length >= 1, 'at least one item carries an outline');
    for (const i of masked) assert.match(i.mask.path, /^M[\d. L-]+Z(M[\d. L-]+Z)*$/);
    assert.ok(masked.some((i) => i.mask.status === 'decoded' && i.mask.path.length > 200), 'a decoded SVG path from the codec');
    assert.ok(body.items.every((i) => i.grams.low <= i.grams.likely && i.grams.likely <= i.grams.high));
    assert.deepEqual([body.photo.width, body.photo.height].map(Number.isInteger), [true, true]);
    assert.ok(!/rawMask|"data"/.test(JSON.stringify(body)), 'raw mask payloads stay on the server');
    const photo = await fetch(app.base + body.photo.url);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  } finally { await app.close(); }
});

test('mock measure: a user-entered gram anchor narrows the range; pho sample has an unconfirmed scale reading', async () => {
  const app = await start({ env: NO_KEY });
  try {
    const m = (await app.post('/api/measure?mock=1', { sample: 'pho-meal005' })).body;
    assert.ok(m.scaleAvailable);
    const item = m.items[0];
    assert.ok(item.grams.high > item.grams.low);
    const a = await app.post('/api/anchor', { sessionId: m.sessionId, itemId: item.itemId, grams: 250 });
    assert.equal(a.status, 200);
    const after = a.body.items.find((i) => i.itemId === item.itemId);
    assert.equal(after.grams.low, 250);
    assert.equal(after.grams.high, 250);
    assert.equal(after.portionSource, 'user-entered');
    assert.equal(after.portionConfidence, 'high');
    assert.deepEqual(after.photoEstimate, item.photoEstimate); // the original range is kept for comparison
    assert.equal((await app.post('/api/anchor', { sessionId: m.sessionId, itemId: item.itemId, grams: -5 })).status, 400);
    const ocr = await app.post('/api/scale-ocr', { sessionId: m.sessionId });
    assert.equal(ocr.body.reading.confirmed, false);
    assert.equal(ocr.body.entry.scale.status, 'unconfirmed');
    // an unconfirmed reading blocks logging
    assert.equal((await app.post('/api/log', { sessionId: m.sessionId })).status, 409);
  } finally { await app.close(); }
});

test('mock mode: forced mock wins over a configured key; the key never reaches a response', async () => {
  const KEY = 'sk-test-key-not-real-123';
  const app = await start({ env: { ...NO_KEY, META_API_KEY: KEY } });
  try {
    const cfg = await (await fetch(`${app.base}/api/config`)).json();
    assert.equal(cfg.mode, 'live');
    const forced = await app.post('/api/measure?mock=1', { sample: 'tacos-meal004' });
    assert.equal(forced.body.mock, true);
    assert.ok(!JSON.stringify([cfg, forced.body]).includes(KEY));
  } finally { await app.close(); }
});

// SOI, SOF0 (640x480), SOS, EOI
const JPEG = Buffer.from('ffd8' + 'ffc0000b08' + '01e0' + '0280' + '01' + '011100' + 'ffda0002ffd9', 'hex');

test('live measure (stubbed transport): photo -> items -> anchor -> log -> day log', async () => {
  const KEY = 'sk-test-key-not-real-456';
  const reply = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': 'r1' }), json: async () => body });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    if (url.endsWith('/chat/completions')) {
      return reply({ model: 'muse-spark-1.3', choices: [{ message: { content: '{"items":[{"name":"cooked rice","grams":{"low":100,"likely":150,"high":200},"confidence":0.8}],"context":{"container":{"type":"bowl","confidence":0.9}}}' } }] });
    }
    return reply({ model: 'sam-3.1', output: [{ content: [{ text: '' }] }] }); // SAM finds nothing: mask-less item
  };
  const app = await start({ env: { ...NO_KEY, META_API_KEY: KEY }, fetchImpl });
  try {
    const m = await app.post('/api/measure', { image: JPEG.toString('base64') });
    assert.equal(m.status, 200);
    assert.equal(m.body.mock, false);
    assert.deepEqual([m.body.photo.width, m.body.photo.height], [640, 480]);
    assert.equal(m.body.items[0].name, 'cooked rice');
    assert.equal(m.body.items[0].mask, null); // mask-less is a supported state
    assert.ok(seen.length >= 2 && seen.every((s) => s.auth === `Bearer ${KEY}`), 'server-side key used for model calls');
    assert.ok(!JSON.stringify(m.body).includes(KEY));
    assert.equal((await app.post('/api/measure', { image: Buffer.from('not a jpeg').toString('base64') })).status, 415);

    const a = await app.post('/api/anchor', { sessionId: m.body.sessionId, itemId: 'i1', grams: 180 });
    assert.equal(a.body.items[0].grams.low, 180);
    const logged = await app.post('/api/log', { sessionId: m.body.sessionId, day: '2026-10-30' });
    assert.equal(logged.status, 200);
    const [entry] = logged.body.day.entries;
    assert.equal(entry.items[0].tags.portion, 'entered grams');
    assert.equal(entry.items[0].tags.portionConfidence, 'high');
    const day = await (await fetch(`${app.base}/api/day?day=2026-10-30`)).json();
    assert.equal(day.entries.length, 1);
    assert.equal(day.totals.kcal.likely, 234); // 180 g x 130 kcal / 100 g
    assert.equal((await (await fetch(`${app.base}/api/day?day=2026-10-29`)).json()).entries.length, 0);
  } finally { await app.close(); }
});

test('day log: plain range sums across entries, persisted to disk', async () => {
  process.env.MEAL_MEASURE_MODE = 'mock';
  const file = join(mkdtempSync(join(tmpdir(), 'mm-log-')), 'log.json');
  const log = createDayLog(file);
  const logged = logEntry(await buildEntry('fixture:beef-rice-bowl', { env: { MEAL_MEASURE_MODE: 'mock' } }));
  log.add(logged, '2026-10-30');
  log.add(logged, '2026-10-30');
  const v = createDayLog(file).view('2026-10-30');
  assert.equal(v.entries.length, 2);
  assert.equal(v.totals.kcal.likely, Math.round(v.entries[0].totals.kcal.likely * 2 * 10) / 10);
  assert.ok(v.totals.kcal.low <= v.totals.kcal.likely && v.totals.kcal.likely <= v.totals.kcal.high);
  assert.deepEqual(Object.keys(v), ['day', 'entries', 'totals']); // sums only: nothing else is computed
});

// ---- web code hygiene ----
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const WEB = files(new URL('../web', import.meta.url).pathname).filter((f) => /\.(js|html|css|webmanifest)$/.test(f));

test('web code: no model-layer / src imports; talks to the pipeline through /api only', () => {
  assert.ok(WEB.length >= 8);
  for (const f of WEB.filter((p) => p.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.{1,2}\//, `${f}: bare import ${m[1]}`);
      assert.ok(!/src\/|model|nutrition|pipeline/.test(m[1]), `${f}: imports ${m[1]}`);
    }
  }
});

test('web modules parse and expose the part-2 plug-in hooks', async () => {
  // app.js touches the DOM at top level; every other module is import-safe under Node.
  for (const f of WEB.filter((p) => p.endsWith('.js') && !/(app|sw)\.js$/.test(p))) await import(f);
  const m = await import(new URL('../web/screens/measure.js', import.meta.url));
  assert.equal(typeof m.registerItemAction, 'function');
  assert.equal(typeof m.registerResultPanel, 'function');
});

test('copy vocabulary (contract 13): no banned words in web strings or the server', () => {
  const BANNED = /\b(coach\w*|advice|advise\w*|recommend\w*|should eat|healthy|unhealthy|diet plan|targets?|bmr|tdee|goal)\b/i;
  for (const f of [...WEB, new URL('../server.mjs', import.meta.url).pathname]) {
    const hit = BANNED.exec(readFileSync(f, 'utf8'));
    assert.equal(hit, null, `${f}: "${hit?.[0]}"`);
  }
});
