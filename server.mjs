#!/usr/bin/env node
// meal-measure app server: static web/ + a small JSON API over the pipeline. node:http only.
//   node server.mjs            (PORT, HOST, META_API_KEY, USDA_API_KEY, MEAL_MEASURE_LOG from env)
// The Meta key lives in this process's environment and is never sent to the browser.
//   mock mode (no key, MEAL_MEASURE_MODE=mock, ?mock=1 or {"mock":true}): recorded samples.
//   live mode (key present): the photo goes through the live pipeline.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getMode } from './src/model/mock.js';
import { loadPhoto } from './src/model/client.js';
import { readScale } from './src/model/scaleOcr.js';
import {
  buildEntry, entryFromRuns, applyAnchor, attachScaleReading, logEntry,
  UnconfirmedScaleReadingError, ScaleDecisionPendingError, IncompleteEntryError,
} from './src/pipeline/measure.js';
import { SAMPLES, DEFAULT_SAMPLE, isSample, loadSampleRuns, samplePhotoPath } from './src/app/samples.js';
import { entryView } from './src/app/view.js';
import { createDayLog, isDay, localDay } from './src/app/dayLog.js';

const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const MAX_BODY = 20 * 1024 * 1024;
const MAX_SESSIONS = 40;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg',
};
const MOCK_LABEL = 'mock data — recorded sample run';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'photo too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'body is not valid JSON'); }
}

// base64 or data URL -> JPEG Buffer
function decodeImage(image) {
  if (typeof image !== 'string' || !image) throw new HttpError(400, 'image is required (base64)');
  const bytes = Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new HttpError(415, 'photo must be a JPEG');
  return bytes;
}

// env: the environment the pipeline sees. dayLogFile: JSON path or null (memory only).
// fetchImpl: transport override for the model / database calls (tests stub it).
export function createApp({ env = process.env, dayLogFile = null, fetchImpl } = {}) {
  const sessions = new Map(); // sessionId -> { entry, mock, sample, tmpDir }
  const dayLog = createDayLog(dayLogFile);
  const serverMode = () => getMode(env);
  const mockEnv = { ...env, MEAL_MEASURE_MODE: 'mock' };

  function remember(session) {
    const id = randomUUID();
    sessions.set(id, session);
    while (sessions.size > MAX_SESSIONS) {
      const [oldId, old] = sessions.entries().next().value;
      sessions.delete(oldId);
      if (old.tmpDir) rm(old.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    return id;
  }
  const session = (id) => {
    const s = sessions.get(id);
    if (!s) throw new HttpError(404, 'unknown or expired measure session: measure the photo again');
    return s;
  };
  const meta = (id, s, photo) => ({
    sessionId: id,
    mock: s.mock,
    mockLabel: s.mock ? MOCK_LABEL : null,
    scaleAvailable: s.scaleAvailable ?? false, // a recorded sample that has a scale-display reading
    photo: photo ?? s.photo,
  });

  const routes = {
    'GET /api/config': async () => ({
      mode: serverMode(), liveAvailable: serverMode() === 'live', mockLabel: MOCK_LABEL, samples: SAMPLES,
    }),

    'POST /api/measure': async (req, url) => {
      const body = await readBody(req);
      const mock = serverMode() === 'mock' || url.searchParams.get('mock') === '1' || body.mock === true;
      if (mock) {
        const id = isSample(body.sample) ? body.sample : DEFAULT_SAMPLE;
        const runs = loadSampleRuns(id);
        const entry = await entryFromRuns(id, runs.spark, runs.sam, { env: mockEnv });
        const photo = { url: `/samples/${id}/photo.jpg`, width: runs.size[0], height: runs.size[1] };
        const s = { entry, mock: true, sample: id, photo, scaleAvailable: Boolean(runs.scale) };
        return entryView(entry, meta(remember(s), s));
      }
      const bytes = decodeImage(body.image);
      const tmpDir = await mkdtemp(join(tmpdir(), 'mm-photo-'));
      const photoPath = join(tmpDir, 'photo.jpg');
      await writeFile(photoPath, bytes, { mode: 0o600 });
      try {
        const [width, height] = loadPhoto(photoPath).size ?? [null, null];
        const entry = await buildEntry(photoPath, { env, fetchImpl });
        const s = { entry, mock: false, tmpDir, photo: { url: null, width, height } };
        return entryView(entry, meta(remember(s), s));
      } catch (err) {
        await rm(tmpDir, { recursive: true, force: true });
        throw err;
      }
    },

    // A scale-display reading is attached UNCONFIRMED; confirming it is a separate step.
    'POST /api/scale-ocr': async (req, url) => {
      const body = await readBody(req);
      const s = body.sessionId ? session(body.sessionId) : null;
      let reading;
      if (s?.mock || (!s && (serverMode() === 'mock' || url.searchParams.get('mock') === '1' || body.mock === true))) {
        const recorded = loadSampleRuns(s?.sample ?? (isSample(body.sample) ? body.sample : DEFAULT_SAMPLE)).scale;
        reading = recorded ?? { status: 'unreadable', rawText: '', provenance: { call: 'scale.ocr', mode: 'mock', fixture: true } };
        reading.provenance = { ...reading.provenance, mockLabel: MOCK_LABEL };
      } else {
        const bytes = decodeImage(body.image);
        const tmpDir = await mkdtemp(join(tmpdir(), 'mm-scale-'));
        try {
          await writeFile(join(tmpDir, 'scale.jpg'), bytes, { mode: 0o600 });
          reading = await readScale(join(tmpDir, 'scale.jpg'), { env, fetchImpl });
        } finally {
          await rm(tmpDir, { recursive: true, force: true });
        }
      }
      const out = { reading: { ...reading, confirmed: false }, mock: Boolean(reading.provenance?.mockLabel) };
      if (s) {
        s.entry = attachScaleReading(s.entry, reading);
        out.entry = entryView(s.entry, meta(body.sessionId, s));
      }
      return out;
    },

    // User-entered grams for one item: replaces the range with a single value (higher confidence).
    'POST /api/anchor': async (req) => {
      const body = await readBody(req);
      const s = session(body.sessionId);
      try {
        s.entry = applyAnchor(s.entry, body.itemId, Number(body.grams), 'user-entered');
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      return entryView(s.entry, meta(body.sessionId, s));
    },

    'POST /api/log': async (req) => {
      const body = await readBody(req);
      const s = session(body.sessionId);
      let logged;
      try {
        logged = logEntry(s.entry);
      } catch (err) {
        if (err instanceof UnconfirmedScaleReadingError || err instanceof ScaleDecisionPendingError || err instanceof IncompleteEntryError) {
          throw new HttpError(409, err.message);
        }
        throw err;
      }
      const day = isDay(body.day) ? body.day : localDay();
      return { entry: dayLog.add(logged, day), day: dayLog.view(day) };
    },

    'GET /api/day': async (req, url) => {
      const day = url.searchParams.get('day');
      return dayLog.view(isDay(day) ? day : localDay());
    },
  };

  async function serveFile(res, path, type) {
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'not found');
    }
  }

  async function serveStatic(res, pathname) {
    const sample = /^\/samples\/([\w-]+)\/photo\.jpg$/.exec(pathname);
    if (sample) {
      if (!isSample(sample[1])) throw new HttpError(404, 'not found');
      return serveFile(res, samplePhotoPath(sample[1]), TYPES['.jpg']);
    }
    let rel;
    try { rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)); } catch { throw new HttpError(400, 'bad path'); }
    const full = join(WEB, rel); // WEB ends with a separator
    if (!full.startsWith(WEB) || rel.includes('\0')) throw new HttpError(404, 'not found');
    return serveFile(res, full, TYPES[extname(full)] ?? 'application/octet-stream');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const out = await route(req, url);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out));
      }
      if (req.method !== 'GET' || url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('server error:', err.name, err.message);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'internal error' : err.message }));
    }
  });
  server.on('close', () => {
    for (const s of sessions.values()) if (s.tmpDir) rm(s.tmpDir, { recursive: true, force: true }).catch(() => {});
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  const dayLogFile = process.env.MEAL_MEASURE_LOG || fileURLToPath(new URL('./data/day-log.json', import.meta.url));
  createApp({ dayLogFile }).listen(port, host, () => {
    console.log(`meal-measure on http://${host}:${port} — ${getMode() === 'live' ? 'live mode' : 'mock mode (recorded samples)'}`);
  });
}
