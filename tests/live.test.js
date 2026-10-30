// Live adapters against a stubbed fetch: no network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyFood, IDENTIFY_PROMPT, SCALE_IGNORE_RULE } from '../src/model/spark.js';
import { segmentItems, parseSegments, itemPrompts } from '../src/model/sam.js';
import { readScale } from '../src/model/scaleOcr.js';
import { loadPhoto } from '../src/model/client.js';

const KEY = 'test-key-not-real';
const env = { META_API_KEY: KEY, MEAL_MEASURE_MODE: 'live' };

// SOI, APP1 (fake EXIF), SOF0 (640x480), SOS, EOI
const jpeg = Buffer.from('ffd8' + 'ffe10008457869660000' + 'ffc0000b08' + '01e0' + '0280' + '01' + '011100' + 'ffda0002ffd9', 'hex');
const photoPath = join(mkdtempSync(join(tmpdir(), 'mm-')), 'p.jpg');
writeFileSync(photoPath, jpeg);

const reply = (body, headers = { 'x-request-id': 'req-1' }) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body });
const chat = (text) => reply({ model: 'muse-spark-1.3', choices: [{ message: { content: text } }] });
const resp = (text) => reply({ model: 'sam-3.1', output: [{ content: [{ text }] }] });

test('loadPhoto strips EXIF and reads dimensions', () => {
  const p = loadPhoto(photoPath);
  assert.equal(p.bytes.includes(Buffer.from('Exif')), false);
  assert.deepEqual(p.size, [640, 480]);
});

test('spark live: prompt carries the scale-ignore rule verbatim; nutrient keys stripped; auth header set', async () => {
  assert.ok(IDENTIFY_PROMPT.includes('Ignore any scale display or numeric readout visible in the photo. Do not use displayed numbers when estimating grams.'));
  assert.equal(SCALE_IGNORE_RULE.length > 0, true);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return chat('```json\n{"items":[{"name":"cooked rice","calories":999,"grams":{"low":100,"likely":150,"high":200},"confidence":0.8}],"context":{"container":{"type":"bowl","confidence":0.9}}}\n```');
  };
  const r = await identifyFood(photoPath, { env, fetchImpl });
  assert.equal(calls[0].url, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'muse-spark-1.3');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(r.items[0].name, 'cooked rice');
  assert.equal(r.provenance.strippedNutrientFields, true);
  assert.equal(r.provenance.requestId, 'req-1');
  assert.equal(r.provenance.mode, 'live');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('spark live: failure yields an empty manual-path result, never a throw, no key in error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({}) });
  const r = await identifyFood(photoPath, { env, fetchImpl });
  assert.deepEqual(r.items, []);
  assert.equal(r.provenance.error.kind, 'auth');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('sam parseSegments reads boxes and optional mask payloads', () => {
  const segs = parseSegments('<|box;x1=10;y1=20;x2=110;y2=220;w=100;h=200|><|mask;x=0;y=0;data=AAAA|><|box;x1=1.5;y1=2;x2=3;y2=4|>');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].box, { x1: 10, y1: 20, x2: 110, y2: 220 });
  assert.equal(segs[0].mask.data, 'AAAA');
  assert.equal(segs[1].mask, null);
  assert.deepEqual(parseSegments(''), []);
});

test('sam item prompts are the simplest noun first', () => {
  assert.deepEqual(itemPrompts('ground beef 90/10'), ['the ground beef', 'the beef']);
  assert.deepEqual(itemPrompts('tacos'), ['the tacos']);
});

test('sam live: empty output retries with a simpler prompt, then records not_found; box mask', async () => {
  const prompts = [];
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/v1\/responses$/);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'sam-3.1');
    const p = body.input[0].content[0].text;
    prompts.push(p);
    if (p === 'the plate') return resp('<|box;x1=64;y1=48;x2=576;y2=432;w=512;h=384|><|mask;x=0;y=0;data=QUJD|>');
    if (p === 'the beef') return resp('<|box;x1=64;y1=48;x2=320;y2=240;w=256;h=192|>');
    return resp(''); // 200 with empty text
  };
  const r = await segmentItems(photoPath, [{ itemId: 'i1', name: 'ground beef 90/10' }, { itemId: 'i2', name: 'mystery sauce' }], { env, fetchImpl });
  assert.deepEqual(prompts, ['the plate', 'the ground beef', 'the beef', 'the mystery sauce', 'the sauce']);
  assert.equal(r.noDishMask, false);
  assert.equal(r.items[0].maskStatus, 'box'); // item segment carried no mask data
  assert.equal(r.items[0].mask.polygon.length, 4);
  assert.deepEqual(r.items[0].mask.bbox, [0.1, 0.1, 0.4, 0.4]);
  assert.equal(r.items[1].mask, null);
  assert.equal(r.items[1].maskReason, 'not_found');
});

test('sam live: transport failure makes every item mask-less (sam_unavailable)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) });
  const r = await segmentItems(photoPath, [{ itemId: 'i1', name: 'rice' }], { env, fetchImpl });
  assert.equal(r.items[0].maskReason, 'sam_unavailable');
  assert.equal(r.noDishMask, true);
});

test('scale ocr live: reading is always unconfirmed even if the model claims confirmed', async () => {
  const fetchImpl = async () => chat('{"rawText":"352 g","value":352,"unit":"g","status":"confirmed"}');
  const r = await readScale(photoPath, { env, fetchImpl });
  assert.equal(r.status, 'unconfirmed');
  assert.equal(r.value, 352);
  const bad = await readScale(photoPath, { env, fetchImpl: async () => chat('{"rawText":"","value":null,"unit":null}') });
  assert.equal(bad.status, 'unreadable');
  const weird = await readScale(photoPath, { env, fetchImpl: async () => chat('{"rawText":"3 stone","value":3,"unit":"stone"}') });
  assert.equal(weird.status, 'unreadable');
});
