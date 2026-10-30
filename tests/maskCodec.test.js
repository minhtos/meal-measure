// SAM mask codec: golden decodes of recorded API masks (expected values cross-checked
// against Meta's reference meta_sam_parser) plus failure-path behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMask, parseMaskData, maskOutline, MaskDecodeError, UnsupportedMaskEncoding } from '../src/model/maskCodec.js';
import { segmentToMask } from '../src/model/sam.js';

const sample = (id) => JSON.parse(readFileSync(new URL(`../data/samples/${id}/sam-segment.json`, import.meta.url), 'utf8'));

const GOLDEN = [
  { id: 'pho-meal005', bytes: 197880, foreground: 63415, width: 510, height: 388 },
  { id: 'tacos-meal004', bytes: 461384, foreground: 110599, width: 749, height: 616 },
];

for (const g of GOLDEN) {
  test(`golden: ${g.id} dish mask decodes to ${g.bytes} bytes, ${g.foreground} foreground`, () => {
    const d = decodeMask(sample(g.id).dish.rawMask.data);
    assert.equal(d.raster.length, g.bytes);
    assert.equal(d.foreground, g.foreground);
    assert.equal(d.width, g.width);
    assert.equal(d.height, g.height);
    assert.equal(d.encoding, 'lossless');
    assert.ok(d.raster.every((v) => v === 0 || v === 1));
  });

  test(`outline: ${g.id} path is closed loops inside the raster`, () => {
    const d = decodeMask(sample(g.id).dish.rawMask.data);
    const o = maskOutline(d);
    assert.ok(o.loops >= 1 && o.polygon.length >= 4);
    assert.match(o.path, /^M[\d. L]+Z(M[\d. L]+Z)*$/);
    for (const [x, y] of o.polygon) assert.ok(x >= 0 && x <= d.width && y >= 0 && y <= d.height);
  });
}

test('outline: signed loop area equals the foreground count (exact tracing)', () => {
  const raster = Uint8Array.from([0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0]); // 4x3, 7 fg pixels, one region
  const o = maskOutline({ raster, width: 4, height: 3 });
  assert.equal(o.loops, 1);
  const a = o.polygon.reduce((s, p, i) => { const q = o.polygon[(i + 1) % o.polygon.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  assert.equal(Math.abs(a) / 2, 7);
});

test('parseMaskData: header, markers, and typed unsupported encoding', () => {
  assert.deepEqual(parseMaskData('3,4,~abc').encoding, 'lossless');
  assert.equal(parseMaskData('3,4,!abc').encoding, 'one_bit');
  assert.throws(() => parseMaskData('3,4,?abc'), UnsupportedMaskEncoding);
  assert.throws(() => parseMaskData('QUJD'), MaskDecodeError);
  assert.throws(() => parseMaskData('0,4,~abc'), MaskDecodeError);
});

test('corrupt payloads throw MaskDecodeError, never anything else', () => {
  const data = sample('pho-meal005').dish.rawMask.data;
  const [h, w, p] = [388, 510, data.split(',').slice(2).join(',')];
  for (const bad of [`${h},${w},${p.slice(0, 40)}`, `${h},${w},${p.slice(0, -3)}`, `${h},${w},~"""""`, `${h},${w},~`]) {
    assert.throws(() => decodeMask(bad), MaskDecodeError);
  }
});

test('segmentToMask: decoded mask replaces the box polygon, keeps bbox + rawMask', () => {
  const s = sample('pho-meal005').dish.rawMask;
  const seg = { box: { x1: 116, y1: 207, x2: 625, y2: 594 }, mask: s };
  const m = segmentToMask(seg, [768, 1024]);
  assert.equal(m.maskStatus, 'decoded');
  assert.equal(m.rawMask, s);
  assert.equal(m.raster.foreground, 63415);
  assert.ok(m.path.startsWith('M'));
  assert.deepEqual(m.bbox, [116 / 768, 207 / 1024, 510 / 768, 388 / 1024]);
  assert.ok(Math.abs(m.areaFrac - 63415 / (768 * 1024)) < 1e-9);
});

test('segmentToMask: any decode failure falls back to the box and never throws', () => {
  const box = { x1: 10, y1: 20, x2: 110, y2: 120 };
  const bad = segmentToMask({ box, mask: { x: 0, y: 0, data: 'QUJD' } }, [200, 200]);
  assert.equal(bad.maskStatus, 'box_decode_failed');
  assert.equal(bad.polygon.length, 4);
  assert.ok(bad.maskError);
  const unsupported = segmentToMask({ box, mask: { x: 0, y: 0, data: '5,5,?zzzzzz' } }, [200, 200]);
  assert.equal(unsupported.maskStatus, 'box_unsupported');
  const none = segmentToMask({ box, mask: null }, [200, 200]);
  assert.equal(none.maskStatus, 'box');
  assert.deepEqual(none.bbox, [0.05, 0.1, 0.5, 0.5]);
});
