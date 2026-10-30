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
// Token grammar: <|kind;key=value;...|>. Fields are read BY KEY, never by position, so
// optional fields (w, h, c) can sit anywhere. A segment is a box token, then optionally a
// mask token. The integer object id (optionally after a '<Nf>' frame marker) is the text
// right before the box token.
const TOKEN = /<\|(\w+);([^|]*)\|>/g;
const ID_BEFORE = /(?:<\d+f>)?\s*(\d+)\s*$/;

function fields(body) {
  const f = {};
  for (const kv of body.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return f;
}
const numOr = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// Parses segments: { id, confidence, box, mask }. Box coordinates are input-image pixels.
// confidence (c, 0..1) is the mask token's if present, else the box's, else null; id is the
// response's integer object id, or null if the response carried none.
export function parseSegments(text) {
  const out = [];
  let prevEnd = 0;
  let last = null;
  for (const m of text.matchAll(TOKEN)) {
    const f = fields(m[2]);
    if (m[1] === 'box') {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => numOr(f[k]));
      if ([x1, y1, x2, y2].includes(null)) {
        last = null;
      } else {
        const idm = ID_BEFORE.exec(text.slice(prevEnd, m.index));
        last = { id: idm ? Number(idm[1]) : null, confidence: numOr(f.c), box: { x1, y1, x2, y2 }, mask: null };
        out.push(last);
      }
    } else if (m[1] === 'mask' && last && !last.mask && f.data !== undefined) {
      last.mask = { x: numOr(f.x) ?? 0, y: numOr(f.y) ?? 0, data: f.data };
      last.confidence = numOr(f.c) ?? last.confidence;
    }
    prevEnd = m.index + m[0].length;
  }
  return out;
}

// Segments keyed by object id (stable within a response, may be sparse). A response with
// no ids falls back to 1-based position; a repeated id keeps the first.
export function segmentsById(segments) {
  const out = {};
  segments.forEach((seg, i) => {
    const id = seg.id ?? i + 1;
    if (!(id in out)) out[id] = { ...seg, id };
  });
  return out;
}
const firstSegment = (byId) => {
  const ids = Object.keys(byId).map(Number).sort((a, b) => a - b);
  return ids.length ? byId[ids[0]] : null;
};

// Box fallback: the segment is represented by its box as a 4-point polygon.
function boxMask(seg, size, maskStatus, maskError = null) {
  const { x1, y1, x2, y2 } = seg.box;
  const [W, H] = size ?? [null, null];
  return {
    polygon: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], // pixel space of the input image
    bbox: W ? [x1 / W, y1 / H, (x2 - x1) / W, (y2 - y1) / H] : null, // normalised [x, y, w, h]
    areaFrac: W ? ((x2 - x1) * (y2 - y1)) / (W * H) : null,
    rawMask: seg.mask, // verbatim
    objectId: seg.id ?? null,
    confidence: seg.confidence ?? null,
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
      objectId: seg.id ?? null,
      confidence: seg.confidence ?? null,
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
    const byId = segmentsById(parseSegments(reply.text));
    const objectIds = Object.keys(byId).map(Number);
    calls.push(provenanceOf('sam.segment', photo, reply, { prompt: p, segments: objectIds.length, objectIds }));
    if (objectIds.length) return byId;
  }
  return {};
}

async function segmentLive(photoRef, items, opts) {
  const photo = loadPhoto(photoRef); // live: photoRef is a JPEG file path
  const calls = [];
  try {
    const dishSeg = firstSegment(await trySam(DISH_PROMPTS, photo, opts, calls));
    const dish = dishSeg ? segmentToMask(dishSeg, photo.size) : null;
    const out = [];
    for (const it of items) {
      const seg = firstSegment(await trySam(itemPrompts(it.name), photo, opts, calls));
      const mask = seg ? segmentToMask(seg, photo.size) : null;
      out.push(mask
        ? { itemId: it.itemId, mask, maskStatus: mask.maskStatus, maskReason: null, confidence: mask.confidence }
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

// ---- point / box prompts (tap refinement) ----
// Prompt grammar, object id 1 on frame 0: '<0f>1' then a box token and/or point tokens; a
// leading '-' makes a point NEGATIVE (only points can be). w/h on every token are the SENT
// image's pixel size; x2/y2 are inclusive. Inputs are normalised 0..1 (docs §7):
// points {x, y, label: 1 include | 0 exclude}, boxes [[x1, y1, x2, y2]] (at most one).
export function buildPointPrompt({ points = [], boxes = [] }, size) {
  if (!size) throw new Error('image size unknown: cannot build a point prompt');
  if (boxes.length > 1) throw new Error('at most one box per object per frame');
  if (!points.length && !boxes.length) throw new Error('a point prompt needs at least one point or box');
  const [W, H] = size;
  const px = (v, max) => Math.min(max - 1, Math.max(0, Math.round(v * max)));
  const wh = `w=${W};h=${H}`;
  const parts = boxes.map(([x1, y1, x2, y2]) => `<|box;x1=${px(x1, W)};y1=${px(y1, H)};x2=${px(x2, W)};y2=${px(y2, H)};${wh}|>`);
  for (const p of points) parts.push(`${p.label === 0 ? '-' : ''}<|point;x=${px(p.x, W)};y=${px(p.y, H)};${wh}|>`);
  return `<0f>1${parts.join('')}`;
}

// One SAM call with a point/box prompt. Returns { mask, reason, provenance }: mask is the
// adapter mask for object 1 (as segmentToMask), or null (reason says why). Transport
// failures throw ModelCallError; the caller owns the fallback.
export async function refineWithPoints(photoRef, prompts, opts = {}) {
  if (getMode(opts.env) !== 'live') return { mask: null, reason: 'mock_mode', provenance: mockProvenance('sam.refine', 'mock mode: no live refine') };
  const photo = loadPhoto(photoRef);
  const prompt = buildPointPrompt(prompts, photo.size);
  const reply = await samRespond(prompt, photo, opts);
  const byId = segmentsById(parseSegments(reply.text));
  const objectIds = Object.keys(byId).map(Number);
  const seg = byId[1] ?? firstSegment(byId);
  const provenance = provenanceOf('sam.refine', photo, reply, { prompt, segments: objectIds.length, objectIds });
  return { mask: seg ? segmentToMask(seg, photo.size) : null, reason: seg ? null : 'not_found', provenance, text: reply.text };
}
