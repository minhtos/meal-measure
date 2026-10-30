// Contract B — SAM segmentation, coarse-to-fine: dish/plate first, then items.
// An item may come back with mask: null (mask-less is a supported state).
//
// Live flow (verified against the hosted API): SAM 3.1 takes a TEXT prompt on
// POST /v1/responses. Prompts must be the simplest noun ('the plate'); descriptive
// prompts return HTTP 200 with EMPTY text, so empty => simplify and retry once.
import { getMode, loadFixture, mockProvenance } from './mock.js';
import { decodeMask, maskOutline, MaskDecodeError, UnsupportedMaskEncoding } from './maskCodec.js';
import { loadPhoto, samRespond, provenanceOf, ModelCallError } from './client.js';

const DISH_PROMPTS = ['the plate', 'the bowl'];
const num = '(-?\\d+(?:\\.\\d+)?)';
const BOX = new RegExp(`<\\|box;x1=${num};y1=${num};x2=${num};y2=${num}(?:;w=${num};h=${num})?\\|>`, 'g');
const MASK = /^<\|mask;x=(-?\d+);y=(-?\d+);data=([^|]*)\|>/;

// Parses '<|box;...|><|mask;...|>' segments. Box coordinates are input-image pixels.
export function parseSegments(text) {
  const out = [];
  for (const m of text.matchAll(BOX)) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
    const rest = MASK.exec(text.slice(m.index + m[0].length));
    out.push({ box: { x1, y1, x2, y2 }, mask: rest ? { x: +rest[1], y: +rest[2], data: rest[3] } : null });
  }
  return out;
}

// Box fallback: the segment is represented by its box as a 4-point polygon.
function boxMask(seg, size, maskStatus, maskError = null) {
  const { x1, y1, x2, y2 } = seg.box;
  const [W, H] = size ?? [null, null];
  return {
    polygon: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], // pixel space of the input image
    bbox: W ? [x1 / W, y1 / H, (x2 - x1) / W, (y2 - y1) / H] : null, // normalised [x, y, w, h]
    areaFrac: W ? ((x2 - x1) * (y2 - y1)) / (W * H) : null,
    rawMask: seg.mask, // verbatim
    maskStatus,
    maskError,
  };
}

// Decodes the segment's mask (see maskCodec.js) into a polygon + SVG path in input-image
// pixels. The API box is inclusive, so the raster spans [x1, x2+1) x [y1, y2+1). On ANY
// failure (or no mask) this degrades to the box and never throws.
// maskStatus: 'decoded' | 'box' (no mask data) | 'box_unsupported' | 'box_decode_failed'.
export function segmentToMask(seg, size) {
  if (!seg.mask) return boxMask(seg, size, 'box');
  try {
    const d = decodeMask(seg.mask.data);
    if (d.foreground === 0) throw new MaskDecodeError('Mask has no foreground pixels.');
    const { x1, y1, x2, y2 } = seg.box;
    const sx = (x2 + 1 - x1) / d.width, sy = (y2 + 1 - y1) / d.height;
    const { path, polygon } = maskOutline(d, { ox: x1, oy: y1, sx, sy });
    const [W, H] = size ?? [null, null];
    const area = d.foreground * sx * sy;
    return {
      polygon, path, // path: fill-rule evenodd
      bbox: W ? [x1 / W, y1 / H, (x2 + 1 - x1) / W, (y2 + 1 - y1) / H] : null,
      areaFrac: W ? area / (W * H) : null,
      rawMask: seg.mask,
      maskStatus: 'decoded',
      maskError: null,
      raster: { width: d.width, height: d.height, foreground: d.foreground, encoding: d.encoding },
    };
  } catch (err) {
    const status = err instanceof UnsupportedMaskEncoding ? 'box_unsupported' : 'box_decode_failed';
    return boxMask(seg, size, status, String(err?.message ?? err));
  }
}

// 'ground beef 90/10' -> ['the beef', ...]: cleaned last two words, then last word.
export function itemPrompts(name) {
  const words = name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const tail = words.slice(-2);
  const prompts = [`the ${tail.join(' ')}`];
  if (tail.length > 1) prompts.push(`the ${tail[1]}`);
  return prompts;
}

async function trySam(prompts, photo, opts, calls) {
  for (const p of prompts) {
    const reply = await samRespond(p, photo, opts);
    const segments = parseSegments(reply.text);
    calls.push(provenanceOf('sam.segment', photo, reply, { prompt: p, segments: segments.length }));
    if (segments.length) return segments;
  }
  return [];
}

async function segmentLive(photoRef, items, opts) {
  const photo = loadPhoto(photoRef); // live: photoRef is a JPEG file path
  const calls = [];
  try {
    const dishSegs = await trySam(DISH_PROMPTS, photo, opts, calls);
    const dish = dishSegs[0] ? segmentToMask(dishSegs[0], photo.size) : null;
    const out = [];
    for (const it of items) {
      const [seg] = await trySam(itemPrompts(it.name), photo, opts, calls);
      const mask = seg ? segmentToMask(seg, photo.size) : null;
      out.push(mask
        ? { itemId: it.itemId, mask, maskStatus: mask.maskStatus, maskReason: null }
        : { itemId: it.itemId, mask: null, maskStatus: 'none', maskReason: 'not_found' });
    }
    return { dish, noDishMask: !dish, items: out, provenance: { calls, mode: 'live' } };
  } catch (err) {
    if (!(err instanceof ModelCallError)) throw err;
    return {
      dish: null, noDishMask: true,
      items: items.map((it) => ({ itemId: it.itemId, mask: null, maskStatus: 'none', maskReason: 'sam_unavailable' })),
      provenance: { calls, mode: 'live', error: { kind: err.kind, message: err.message } },
    };
  }
}

export async function segmentItems(photoRef, items, opts = {}) {
  if (getMode(opts.env) === 'live') return segmentLive(photoRef, items, opts);
  const fx = loadFixture('sam.json', photoRef);
  const rec = fx?.data ?? { dish: null, items: {} };
  return {
    dish: rec.dish ?? null, // pass 1 (coarse)
    noDishMask: !rec.dish, // not an error: dish falls back to the whole image
    items: items.map((it) => {
      const mask = rec.items?.[it.itemId] ?? null; // pass 2 (fine)
      return mask
        ? { itemId: it.itemId, mask, maskStatus: 'present', maskReason: null }
        : { itemId: it.itemId, mask: null, maskStatus: 'none', maskReason: 'not_found' };
    }),
    provenance: mockProvenance('sam.segment', fx?.label ?? 'FIXTURE — no recording for this photo; no masks'),
  };
}
