// SAM confidence, object-id keying, point/box prompts, and the refineMask fallback.
// Stubbed fetch only: no network, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSegments, segmentsById, buildPointPrompt, refineWithPoints, segmentItems } from '../src/model/sam.js';
import { refineMask } from '../src/pipeline/measure.js';

const env = { META_API_KEY: 'test-key-not-real', MEAL_MEASURE_MODE: 'live' };

// SOI, SOF0 (640x480), SOS, EOI
const jpeg = Buffer.from('ffd8' + 'ffc0000b08' + '01e0' + '0280' + '01' + '011100' + 'ffda0002ffd9', 'hex');
const photoPath = join(mkdtempSync(join(tmpdir(), 'mm-')), 'p.jpg');
writeFileSync(photoPath, jpeg);

const reply = (body) => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': 'req-1' }), json: async () => body });
const resp = (text) => reply({ model: 'sam-3.1', output: [{ content: [{ text }] }] });

// A real lossless mask (pho dish, 616 rows x 749 cols) so decode succeeds end to end.
const dish = JSON.parse(readFileSync(new URL('../data/samples/pho-meal005/sam-segment.json', import.meta.url), 'utf8')).dish.rawMask.data;
const GOOD = `<0f>1<|box;x1=0;y1=0;x2=748;y2=615;w=640;h=480|><|mask;x=0;y=0;c=0.87;data=${dish}|>`;

test('parseSegments reads fields by key: c on box and mask, any order, absent c => null', () => {
  const [a, b, c] = parseSegments(
    '<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=20;c=0.9|><|mask;x=5;y=6;c=0.87;data=AAAA|>' + // c between y and data
    '<|box;c=0.5;h=20;w=10;y2=40;x2=30;y1=20;x1=10|><|mask;data=BBBB;y=2;x=1|>' + // scrambled order
    '<|box;x1=7;y1=8;x2=9;y2=10|><|mask;x=0;y=0;data=CCCC|>', // no c at all
  );
  assert.equal(a.confidence, 0.87); // mask token's c wins over the box's
  assert.deepEqual(a.mask, { x: 5, y: 6, data: 'AAAA' });
  assert.equal(b.confidence, 0.5); // falls back to the box c
  assert.deepEqual(b.box, { x1: 10, y1: 20, x2: 30, y2: 40 });
  assert.deepEqual(b.mask, { x: 1, y: 2, data: 'BBBB' });
  assert.equal(c.confidence, null);
  assert.equal(c.mask.data, 'CCCC');
});

test('parseSegments: object ids (optional frame marker) key segments, sparse ids preserved', () => {
  const segs = parseSegments('<0f>3<|box;x1=1;y1=1;x2=2;y2=2|>7<|box;x1=3;y1=3;x2=4;y2=4|><|mask;x=0;y=0;data=AA|>');
  assert.deepEqual(segs.map((s) => s.id), [3, 7]);
  const byId = segmentsById(segs);
  assert.deepEqual(Object.keys(byId), ['3', '7']);
  assert.equal(byId[7].mask.data, 'AA');
  assert.equal(byId[3].mask, null);
  // no ids in the response: falls back to 1-based position
  assert.deepEqual(Object.keys(segmentsById(parseSegments('<|box;x1=1;y1=1;x2=2;y2=2|><|box;x1=3;y1=3;x2=4;y2=4|>'))), ['1', '2']);
});

test('segmentItems live: sends include_confidence, exposes confidence and keys by lowest object id', async () => {
  let metadata;
  const fetchImpl = async (url, init) => {
    metadata = JSON.parse(init.body).metadata;
    return resp('<0f>9<|box;x1=0;y1=0;x2=99;y2=99;c=0.4|>4<|box;x1=10;y1=10;x2=19;y2=19;c=0.65|>');
  };
  const r = await segmentItems(photoPath, [{ itemId: 'i1', name: 'rice' }], { env, fetchImpl });
  assert.deepEqual(metadata, { include_confidence: 'true' });
  assert.equal(r.items[0].mask.objectId, 4); // sparse ids: lowest id, not position
  assert.equal(r.items[0].confidence, 0.65);
  assert.deepEqual(r.provenance.calls[0].objectIds, [4, 9]);
  const noC = await segmentItems(photoPath, [{ itemId: 'i1', name: 'rice' }], { env, fetchImpl: async () => resp('<|box;x1=0;y1=0;x2=9;y2=9|>') });
  assert.equal(noC.items[0].confidence, null);
});

test('buildPointPrompt: object 1, negative points get a leading -, w/h = sent size on every token', () => {
  const size = [640, 480];
  assert.equal(
    buildPointPrompt({ points: [{ x: 0.5, y: 0.5, label: 1 }, { x: 0.1, y: 0.1, label: 0 }] }, size),
    '<0f>1<|point;x=320;y=240;w=640;h=480|>-<|point;x=64;y=48;w=640;h=480|>',
  );
  assert.equal(
    buildPointPrompt({ boxes: [[0.1, 0.2, 0.5, 1]], points: [{ x: 1, y: 1, label: 1 }] }, size),
    '<0f>1<|box;x1=64;y1=96;x2=320;y2=479;w=640;h=480|><|point;x=639;y=479;w=640;h=480|>', // clamped inside the image
  );
  assert.throws(() => buildPointPrompt({ boxes: [[0, 0, 1, 1], [0, 0, 1, 1]] }, size), /one box/);
  assert.throws(() => buildPointPrompt({}, size), /at least one/);
  assert.throws(() => buildPointPrompt({ points: [{ x: 0.5, y: 0.5, label: 1 }] }, null), /size unknown/);
});

test('refineWithPoints: sends the prompt in input_text, decodes object 1 with confidence', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return resp(GOOD); };
  const r = await refineWithPoints(photoPath, { points: [{ x: 0.5, y: 0.5, label: 1 }] }, { env, fetchImpl });
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.equal(body.input[0].content[0].text, '<0f>1<|point;x=320;y=240;w=640;h=480|>');
  assert.equal(r.mask.maskStatus, 'decoded');
  assert.equal(r.mask.confidence, 0.87);
  assert.equal(r.provenance.call, 'sam.refine');
});

const entry = () => ({
  photoRef: photoPath,
  items: [{ itemId: 'i1', food: { name: 'rice' }, mask: { old: true }, maskReason: 'not_found', portion: { mask: 'box' } }],
  warnings: [],
  provenance: { calls: [] },
});
const tap = { x: 0.5, y: 0.5, label: 1 };

test('refineMask: success replaces the mask and remembers the tap for the next prompt', async () => {
  const prompts = [];
  const fetchImpl = async (url, init) => { prompts.push(JSON.parse(init.body).input[0].content[0].text); return resp(GOOD); };
  const e1 = await refineMask(entry(), 'i1', tap, { env, fetchImpl });
  assert.equal(e1.items[0].mask.maskStatus, 'decoded');
  assert.equal(e1.items[0].maskReason, null);
  assert.equal(e1.warnings.length, 0);
  await refineMask(e1, 'i1', { x: 0.1, y: 0.1, label: 0 }, { env, fetchImpl });
  assert.equal(prompts[1], '<0f>1<|point;x=320;y=240;w=640;h=480|>-<|point;x=64;y=48;w=640;h=480|>');
});

test('refineMask fallback: every failure keeps the old mask and warns', async () => {
  const cases = {
    transport: async () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}) }),
    empty: async () => resp(''),
    undecodable: async () => resp('<0f>1<|box;x1=0;y1=0;x2=9;y2=9|><|mask;x=0;y=0;data=2,2,?junk|>'),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const before = entry();
    const after = await refineMask(before, 'i1', tap, { env, fetchImpl });
    assert.deepEqual(after.items[0].mask, { old: true }, name);
    assert.equal(after.items[0].maskPoints, undefined, `${name}: failed tap is not remembered`);
    assert.equal(after.warnings[0].code, 'mask-refine-failed', name);
  }
  // mock mode (no key): same fallback, no network
  const mock = await refineMask(entry(), 'i1', tap, { env: {} });
  assert.deepEqual(mock.items[0].mask, { old: true });
  assert.equal(mock.warnings[0].reason, 'mock_mode');
});
