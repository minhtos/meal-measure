// SAM 3.1 mask codec — a JS port of Meta's reference (meta_sam_parser/_mask_codec.py).
// Wire form of a mask's data field: '<H>,<W>,<payload>'. The payload's first char is the
// encoding marker: '~' lossless (API default; adaptive range coder, foreground = coverage
// byte >= 129) or '!' one_bit (context-modelled bits). The rest is base85 over a custom
// alphabet (printable ASCII '!'..'~' minus the wire delimiters " \ , ; < > |), preceded by a
// 5-char length prefix. The raster is mask-local; it maps onto the segment's box.
//
// Outline: exact pixel-edge boundary loops (every fg/bg edge, chained into closed loops,
// collinear runs merged). Chosen over marching-squares midpoints because it is simple,
// lossless (fill-rule evenodd reproduces the raster) and needs no smoothing decisions.

export class MaskDecodeError extends Error {
  constructor(message) { super(message); this.name = 'MaskDecodeError'; }
}
export class UnsupportedMaskEncoding extends MaskDecodeError {
  constructor(marker) { super(`Unsupported mask encoding marker ${JSON.stringify(marker)}.`); this.name = 'UnsupportedMaskEncoding'; this.marker = marker; }
}

const bad = (msg) => new MaskDecodeError(msg);

const EXCLUDED = new Set(['"', '\\', ',', ';', '<', '>', '|']);
const VALUES = new Int16Array(128).fill(-1);
{
  let i = 0;
  for (let c = 0x21; c < 0x7f; c++) if (!EXCLUDED.has(String.fromCharCode(c))) VALUES[c] = i++;
}
const RADIX = 85;
const PREFIX = 5;
const MAX_PIXELS = 1 << 26; // 64 Mpx: refuse absurd headers before allocating

function digit(payload, i) {
  const c = payload.charCodeAt(i);
  const v = c < 128 ? VALUES[c] : -1;
  if (v < 0 || v >= RADIX) throw bad('Mask payload contains an invalid character.');
  return v;
}

// base85 text (after the marker) -> bytes. Strict: length prefix, group range, tail padding.
function unpack(payload) {
  if (payload.length < PREFIX) throw bad('Mask payload is missing its length prefix.');
  let length = 0;
  for (let i = 0; i < PREFIX; i++) length = length * RADIX + digit(payload, i);
  const rem = length % 4;
  const expected = PREFIX + Math.floor(length / 4) * 5 + (rem === 0 ? 0 : rem + 1);
  if (payload.length !== expected) throw bad('Mask payload length does not match its prefix.');
  const out = new Uint8Array(length);
  let src = PREFIX;
  let dst = 0;
  const full = length - rem;
  while (dst < full) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + digit(payload, src + i);
    if (v > 0xffffffff) throw bad('Mask payload contains an out-of-range group.');
    src += 5;
    out[dst++] = v >>> 24; out[dst++] = (v >>> 16) & 255; out[dst++] = (v >>> 8) & 255; out[dst++] = v & 255;
  }
  if (rem > 0) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + (i < rem + 1 ? digit(payload, src + i) : RADIX - 1);
    if (v > 0xffffffff) throw bad('Mask payload contains an out-of-range tail.');
    for (let i = 0; i < rem; i++) out[dst + i] = (v >>> (24 - i * 8)) & 255;
    // canonical tail: the unused low bits must be exactly what the encoder would emit
    let tv = 0;
    for (let i = 0; i < 4; i++) tv = tv * 256 + (i < rem ? out[dst + i] : 0);
    const digits = [];
    for (let i = 0; i < 5; i++) { digits.unshift(tv % RADIX); tv = Math.floor(tv / RADIX); }
    for (let i = 0; i <= rem; i++) if (digits[i] !== digit(payload, src + i)) throw bad('Mask payload is not in canonical form.');
  }
  return out;
}

const TOP = 1 << 24;
const BOTTOM = 1 << 16;

class RangeDecoder {
  constructor(input) {
    if (input.length < 4) throw bad('Mask payload is missing its finalization.');
    this.input = input; this.pos = 0; this.low = 0; this.range = 0xffffffff; this.code = 0; this.scaled = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.read()) >>> 0;
  }
  read() {
    if (this.pos >= this.input.length) throw bad('Mask payload ended before decoding completed.');
    return this.input[this.pos++];
  }
  freq(total) {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) throw bad('Mask payload has invalid coding state.');
    const v = Math.floor(((this.code - this.low) >>> 0) / this.scaled);
    return v >= total ? total - 1 : v;
  }
  decode(cum, freq) {
    this.low = (this.low + this.scaled * cum) >>> 0;
    this.range = this.scaled * freq;
    for (;;) {
      if (((this.low ^ ((this.low + this.range) >>> 0)) >>> 0) < TOP) { /* shift */ }
      else if (this.range < BOTTOM) this.range = ((-this.low) >>> 0) & (BOTTOM - 1);
      else break;
      this.code = ((this.code << 8) | this.read()) >>> 0;
      this.low = (this.low << 8) >>> 0;
      this.range = (this.range << 8) >>> 0;
    }
  }
}

function paeth(l, u, ul) {
  const e = l + u - ul;
  const dl = Math.abs(e - l), du = Math.abs(e - u), dul = Math.abs(e - ul);
  if (dl <= du && dl <= dul) return l;
  return du <= dul ? u : ul;
}

function predict(out, off, x, y, mode, w) {
  if (mode < 0 || mode >= 5) throw bad('Lossless mask payload uses an invalid predictor.');
  const left = x > 0 ? out[off - 1] : 0;
  const up = y > 0 ? out[off - w] : 0;
  if (mode === 1) return up;
  if (mode === 2) return left;
  if (mode === 3) return (left + up) >> 1;
  const ul = x > 0 && y > 0 ? out[off - w - 1] : 0;
  if (mode === 0) return paeth(left, up, ul);
  if (ul >= Math.max(left, up)) return Math.min(left, up);
  if (ul <= Math.min(left, up)) return Math.max(left, up);
  return left + up - ul;
}

function zeroContext(res, off, x, y, w) {
  const l = x > 0 ? +(res[off - 1] === 0) : 1;
  const u = y > 0 ? +(res[off - w] === 0) : 1;
  const ul = x > 0 && y > 0 ? +(res[off - w - 1] === 0) : 1;
  const ur = y > 0 && x < w - 1 ? +(res[off - w + 1] === 0) : 1;
  return l | (u << 1) | (ul << 2) | (ur << 3);
}

function decodeLossless(payload, w, h) {
  const packed = unpack(payload.slice(1));
  if (packed.length < 5) throw bad('Lossless mask payload is truncated.');
  const selector = packed[0];
  const dec = new RangeDecoder(packed.subarray(1));
  const n = w * h;
  const out = new Uint8Array(n);
  const res = new Uint8Array(n);
  const zc = new Uint32Array(32).fill(1);
  const o1 = new Uint16Array(256 * 256).fill(1);
  const o1t = new Int32Array(256).fill(256);
  const o0 = new Uint16Array(256).fill(2);
  let o0t = 512;
  const o2 = new Map();
  let prev = 0;
  for (let off = 0; off < n; off++) {
    const x = off % w, y = (off - x) / w;
    const zo = zeroContext(res, off, x, y, w) << 1;
    const zero = zc[zo], nonzero = zc[zo + 1];
    const bit = dec.freq(zero + nonzero) < zero ? 0 : 1;
    dec.decode(bit ? zero : 0, bit ? nonzero : zero);
    zc[zo + bit] += 32;
    if (zc[zo] + zc[zo + 1] >= 16384) { zc[zo] = (zc[zo] >> 1) || 1; zc[zo + 1] = (zc[zo + 1] >> 1) || 1; }
    let sym = 0;
    if (bit) {
      const above = off >= w ? res[off - w] : 0;
      const key = (prev << 8) | above;
      let s2 = o2.get(key);
      if (!s2) { s2 = new Uint16Array(257); o2.set(key, s2); }
      const fo = prev << 8;
      const total = s2[256] + o1t[prev] + o0t - (s2[0] + o1[fo] + o0[0]);
      const target = dec.freq(total);
      let cum = 0;
      sym = 1;
      let f = s2[1] + o1[fo + 1] + o0[1];
      while (cum + f <= target) {
        cum += f; sym++;
        if (sym >= 256) throw bad('Lossless mask payload is malformed.');
        f = s2[sym] + o1[fo + sym] + o0[sym];
      }
      dec.decode(cum, f);
      s2[sym] += 14 * 44; s2[256] += 14 * 44;
      if (s2[256] >= 14 * 3584) {
        let t = 0;
        for (let v = 0; v < 256; v++) { s2[v] >>= 1; t += s2[v]; }
        s2[256] = t;
      }
      o1[fo + sym] += 56; o1t[prev] += 56;
      if (o1t[prev] >= 8192) {
        let t = 0;
        for (let v = 0; v < 256; v++) { const s = (o1[fo + v] >> 1) || 1; o1[fo + v] = s; t += s; }
        o1t[prev] = t;
      }
      o0[sym] += 32; o0t += 32;
      if (o0t >= 4096) {
        let t = 0;
        for (let v = 0; v < 256; v++) { o0[v] >>= 1; t += o0[v]; }
        o0t = t;
      }
    }
    res[off] = sym;
    const delta = sym & 1 ? -((sym + 1) >> 1) : sym >> 1;
    out[off] = (predict(out, off, x, y, selector, w) + delta) & 255;
    prev = sym;
  }
  for (let i = 0; i < n; i++) out[i] = out[i] >= 129 ? 1 : 0;
  return out;
}

// one_bit: 12-pixel causal context, adaptive binary range coder. The reference additionally
// re-encodes and compares for canonical form; we skip that (decode is still strict on framing).
function decodeOneBit(payload, w, h) {
  const dec = new RangeDecoder(unpack(payload.slice(1)));
  const counts = new Uint16Array(4096 * 2).fill(1);
  const pw = w + 4;
  const pad = new Uint8Array(pw * (h + 2));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y + 2) * pw + 2;
    for (let x = 0; x < w; x++) {
      const p = row + x, a = p - pw, b = p - 2 * pw;
      const ctx = pad[p - 1] | (pad[p - 2] << 1) | (pad[a - 2] << 2) | (pad[a - 1] << 3) | (pad[a] << 4) |
        (pad[a + 1] << 5) | (pad[a + 2] << 6) | (pad[b - 2] << 7) | (pad[b - 1] << 8) | (pad[b] << 9) |
        (pad[b + 1] << 10) | (pad[b + 2] << 11);
      const o = ctx << 1;
      const zero = counts[o], one = counts[o + 1];
      const bit = dec.freq(zero + one) < zero ? 0 : 1;
      if (bit) dec.decode(zero, one); else dec.decode(0, zero);
      pad[p] = bit; out[y * w + x] = bit;
      counts[o + bit] += 14;
      if (counts[o] + counts[o + 1] >= 4096) { counts[o] = (counts[o] >> 1) || 1; counts[o + 1] = (counts[o + 1] >> 1) || 1; }
    }
  }
  return out;
}

// '<H>,<W>,<payload>' -> { width, height, payload, encoding }. Throws MaskDecodeError.
export function parseMaskData(data) {
  if (typeof data !== 'string') throw bad('Mask data must be a string.');
  const m = /^(\d+),(\d+),(.+)$/s.exec(data);
  if (!m) throw bad('Mask data is not <H>,<W>,<payload>.');
  const height = Number(m[1]), width = Number(m[2]);
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) throw bad('Mask dimensions are out of range.');
  const marker = m[3][0];
  if (marker !== '~' && marker !== '!') throw new UnsupportedMaskEncoding(marker);
  return { width, height, payload: m[3], encoding: marker === '~' ? 'lossless' : 'one_bit' };
}

// -> { width, height, raster: Uint8Array(width*height) of 0/1, foreground, encoding }
export function decodeMask(data) {
  const { width, height, payload, encoding } = parseMaskData(data);
  let raster;
  try {
    raster = encoding === 'lossless' ? decodeLossless(payload, width, height) : decodeOneBit(payload, width, height);
  } catch (err) {
    throw err instanceof MaskDecodeError ? err : new MaskDecodeError(`Mask payload could not be decoded: ${err.message}`);
  }
  let foreground = 0;
  for (let i = 0; i < raster.length; i++) foreground += raster[i];
  return { width, height, raster, foreground, encoding };
}

// Boundary loops of the raster as vertex lists in raster-local pixel-corner coordinates.
// Each fg/bg pixel edge is directed with fg on the right (clockwise on screen); edges are
// chained into closed loops, then collinear vertices are dropped.
export function traceLoops(raster, width, height) {
  const V = width + 1;
  const next = new Map(); // start vertex -> [end vertices]
  const add = (a, b) => { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); };
  const fg = (x, y) => x >= 0 && y >= 0 && x < width && y < height && raster[y * width + x] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!raster[y * width + x]) continue;
      const tl = y * V + x, tr = tl + 1, bl = tl + V, br = bl + 1;
      if (!fg(x, y - 1)) add(tl, tr);
      if (!fg(x + 1, y)) add(tr, br);
      if (!fg(x, y + 1)) add(br, bl);
      if (!fg(x - 1, y)) add(bl, tl);
    }
  }
  const loops = [];
  for (const [start, list] of next) {
    while (list.length) {
      const pts = [];
      let cur = start;
      do {
        pts.push(cur);
        cur = next.get(cur).pop();
      } while (cur !== start);
      loops.push(simplify(pts, V));
    }
  }
  return loops;
}

function simplify(ids, V) {
  const pts = ids.map((id) => [id % V, Math.floor(id / V)]);
  const n = pts.length;
  return pts.filter((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

const fmt = (v) => String(Math.round(v * 100) / 100);

// SVG path (use fill-rule evenodd) and the largest loop as a polygon, both mapped through
// x' = ox + x*sx, y' = oy + y*sy (raster-local -> image pixels).
export function maskOutline(decoded, { ox = 0, oy = 0, sx = 1, sy = 1 } = {}) {
  const loops = traceLoops(decoded.raster, decoded.width, decoded.height)
    .map((l) => l.map(([x, y]) => [ox + x * sx, oy + y * sy]));
  const area = (l) => Math.abs(l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0));
  const largest = loops.reduce((best, l) => (!best || area(l) > area(best) ? l : best), null);
  const path = loops.map((l) => `M${l.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join('L')}Z`).join('');
  return { path, polygon: largest ?? [], loops: loops.length };
}
