// Hash router + shared state. Each screen is mount(root, ctx) -> optional cleanup, registered in
// `screens`; part-2 screens (correction sheet, scale confirm, benchmark) plug in here or through
// the hooks exported by screens/measure.js.
import { api } from './api.js';
import { mountCapture } from './screens/capture.js';
import { mountMeasure } from './screens/measure.js';
import { mountDayLog } from './screens/dayLog.js';
import { mountPlaceholder } from './screens/placeholder.js';

const view = document.getElementById('view');
const chip = document.getElementById('mock-chip');

export const ctx = {
  config: { mode: 'mock', samples: [] },
  pending: null, // a measure request waiting to run: { photo, scale, sample }
  result: null, // the latest measured meal (server view)
  go: (route) => { location.hash = `#/${route}`; },
  // The 'mock data' label is visible whenever anything on screen is recorded sample data.
  showMock: (on) => { chip.hidden = !on; },
};

const screens = {
  capture: mountCapture,
  measure: mountMeasure,
  log: mountDayLog,
  barcode: (root) => mountPlaceholder(root, ctx, { title: 'Barcode', body: 'Scan or type a barcode to measure a packaged food from its label data. This arrives in the next update; for now, measure from a photo.' }),
  quick: (root) => mountPlaceholder(root, ctx, { title: 'Quick meals', body: 'Log a meal you repeat without a photo. This arrives in the next update; for now, measure from a photo.' }),
};

let cleanup = null;
async function route() {
  const name = location.hash.replace(/^#\//, '').split(/[/?]/)[0] || 'capture';
  const mount = screens[name] ?? screens.capture;
  cleanup?.();
  view.replaceChildren();
  document.querySelectorAll('.tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === (name === 'log' ? 'log' : 'capture')));
  ctx.showMock(ctx.config.mode === 'mock' || Boolean(name === 'measure' && ctx.result?.mock));
  cleanup = (await mount(view, ctx)) ?? null;
  view.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);
try { ctx.config = await api.config(); } catch { /* server unreachable: screens show their own errors */ }
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
