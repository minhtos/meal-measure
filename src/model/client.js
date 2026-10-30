// Live Meta HTTP client (docs/INTEGRATION.md §5). Keys come from process.env only
// and never appear in errors, logs, or provenance.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';

export class ModelCallError extends Error {
  constructor(kind, message, retryable = false) {
    super(message);
    this.name = 'ModelCallError';
    this.kind = kind; // no_key | auth | timeout | http | schema | unreadable
    this.retryable = retryable;
  }
}

// Loads a photo from a file path, drops EXIF/APP1 segments (location etc.),
// and returns the bytes actually sent, their sha256, and a data URL.
export function loadPhoto(path) {
  let bytes = readFileSync(path);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const out = [bytes.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff && bytes[i + 1] !== 0xda) {
      const len = bytes.readUInt16BE(i + 2);
      if (bytes[i + 1] !== 0xe1) out.push(bytes.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    out.push(bytes.subarray(i));
    bytes = Buffer.concat(out);
  }
  return {
    bytes,
    size: jpegSize(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  };
}

// [width, height] from the JPEG SOF marker, or null.
function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

async function post(path, body, { env = process.env, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const key = env.META_API_KEY;
  if (!key) throw new ModelCallError('no_key', 'META_API_KEY is not set');
  const url = `${env.META_API_BASE_URL || DEFAULT_BASE_URL}${path}`;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 || res.status === 403) throw new ModelCallError('auth', `HTTP ${res.status}`);
      if (res.status >= 500 && attempt === 0) continue; // one retry on 5xx
      if (!res.ok) throw new ModelCallError('http', `HTTP ${res.status}`, res.status >= 500);
      const json = await res.json();
      return {
        json,
        requestId: res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? json.id ?? null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof ModelCallError) throw err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (attempt === 0) continue; // one retry on timeout / network error
      throw new ModelCallError(timedOut ? 'timeout' : 'http', timedOut ? 'request timed out' : 'network error', true);
    }
  }
}

// Spark: chat/completions with the image as a data-URL image_url part.
export async function sparkChat(prompt, photo, opts = {}) {
  const env = opts.env ?? process.env;
  const r = await post('/chat/completions', {
    model: env.META_SPARK_MODEL || SPARK_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: photo.dataUrl } }] }],
  }, opts);
  const text = r.json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new ModelCallError('schema', 'no message content in chat response');
  return { text, model: r.json.model ?? SPARK_MODEL, requestId: r.requestId, latencyMs: r.latencyMs, raw: r.json };
}

// SAM 3.1: /responses (not chat/completions), text prompt + input_image.
// metadata values are strings; include_confidence adds ;c=<0..1> to box and mask tokens.
export async function samRespond(prompt, photo, opts = {}) {
  const env = opts.env ?? process.env;
  const r = await post('/responses', {
    model: env.META_SAM_MODEL || SAM_MODEL,
    metadata: { include_confidence: 'true' },
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: photo.dataUrl }] }],
  }, opts);
  const text = r.json?.output?.[0]?.content?.[0]?.text;
  if (typeof text !== 'string') throw new ModelCallError('schema', 'no output text in responses reply');
  return { text, model: r.json.model ?? SAM_MODEL, requestId: r.requestId, latencyMs: r.latencyMs, raw: r.json };
}

export const provenanceOf = (call, photo, r, extra = {}) => ({
  call, mode: 'live', model: r.model, requestId: r.requestId, inputSha256: photo.sha256,
  at: new Date().toISOString(), latencyMs: r.latencyMs, ...extra,
});
