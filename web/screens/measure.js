// Measure screen: the photo with each item's mask outline over it, name + gram-range labels,
// and per-item range bars that narrow when grams are anchored (user-entered now; a confirmed
// scale reading in part 2 goes through the same update path).
//
// Part-2 plug-ins:
//   registerItemAction(({ item, ctx, update }) => Node|null)   extra controls inside each item row
//   registerResultPanel(({ result, ctx, update }) => Node|null) extra panels under the list
//     (scale-confirm flow). Both re-run on every update(result).
import { api } from '../api.js';
import { el, svgEl, num, rangeText, gramsText, today, NUTRIENTS } from '../util.js';

const itemActions = [];
const resultPanels = [];
export const registerItemAction = (fn) => itemActions.push(fn);
export const registerResultPanel = (fn) => resultPanels.push(fn);

const PORTION_TAG = { 'photo-estimate': 'estimate', 'user-entered': 'entered grams', 'scale-confirmed': 'scale (verified)' };
const CONF_TAG = { low: 'low confidence', high: 'higher confidence' };
const tag = (text, cls = '') => el('span', { class: `tag ${cls}`.trim() }, text);

const idText = (c) => (typeof c === 'number' ? `identified ${Math.round(c * 100)}%` : 'identification confirmed');
const colorOf = (i) => `var(--c${i % 8})`;

// ---- one list row (+ its stage label), built once and updated in place so bars animate ----
function buildRow(item, index, ctx, update) {
  const max = (Math.max(item.photoEstimate?.high ?? 0, item.grams?.high ?? 0) || 100) * 1.15;
  const pct = (v) => Math.min(100, (v / max) * 100);

  const name = el('strong', { class: 'name' });
  const tags = el('div', { class: 'tags' });
  const ghost = el('i', { class: 'ghost' });
  const fill = el('i', { class: 'fill' });
  const mid = el('i', { class: 'mid' });
  const bar = el('div', { class: 'rbar', role: 'img' }, ghost, fill, mid);
  const gramsLine = el('span', { class: 'grams' });
  const nutr = el('p', { class: 'nutr' });
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const input = el('input', { type: 'number', inputmode: 'decimal', min: '1', step: 'any', placeholder: 'grams', 'aria-label': `Weighed grams for ${item.name}` });
  const form = el('form', { class: 'edit' }, el('label', {}, 'Weighed it?'), input, el('button', { class: 'btn small', type: 'submit' }, 'Set grams'));
  const actions = el('div', { class: 'actions' });

  const li = el('li', { class: 'item', 'data-id': item.itemId, style: `--c:${colorOf(index)};--i:${index}` },
    el('div', { class: 'head' }, el('i', { class: 'dot' }), name), tags,
    el('div', { class: 'range' }, bar, gramsLine), nutr,
    item.mask ? null : el('p', { class: 'nomask' }, 'No outline for this item.'),
    form, err, actions);

  const labelName = el('span', { class: 'ln' });
  const labelRange = el('span', { class: 'lr' });
  const label = item.mask?.bbox
    ? el('div', { class: 'label', style: `left:${item.mask.bbox[0] * 100}%;top:${item.mask.bbox[1] * 100}%;--c:${colorOf(index)};--i:${index}` }, el('i', { class: 'dot' }), labelName, labelRange)
    : null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const grams = Number(input.value);
    if (!(grams > 0)) { err.textContent = 'Enter a weight in grams.'; err.hidden = false; return; }
    err.hidden = true;
    try {
      update(await api.anchor(ctx.result.sessionId, item.itemId, grams));
      input.value = '';
    } catch (e2) { err.textContent = e2.message; err.hidden = false; }
  });

  let last = null;
  function set(it) {
    name.textContent = it.name;
    tags.replaceChildren(
      tag(PORTION_TAG[it.portionSource] ?? 'no portion yet'),
      it.portionConfidence in CONF_TAG ? tag(CONF_TAG[it.portionConfidence]) : null,
      tag(it.corrected ? 'corrected' : idText(it.identificationConfidence)),
      it.nearMiss ? tag('close match: verify', 'warn') : null,
    );
    const g = it.grams;
    if (g) {
      const point = g.low === g.high;
      fill.style.left = `calc(${pct(g.low)}% - ${point ? 4 : 0}px)`;
      fill.style.width = `${Math.max(pct(g.high) - pct(g.low), 0)}%`;
      mid.style.left = `${pct(g.likely)}%`;
      fill.classList.toggle('point', point);
      bar.setAttribute('aria-label', `${it.name}: ${gramsText(g)}`);
      gramsLine.textContent = point ? `${num(g.low)} g` : `${rangeText(g)} g`;
      if (it.portionSource !== 'photo-estimate') gramsLine.append(el('small', {}, ` ${PORTION_TAG[it.portionSource]}`));
      else gramsLine.append(el('small', {}, ` logs ≈ ${num(g.likely)} g`));
    } else {
      gramsLine.textContent = 'no portion estimate';
    }
    if (it.photoEstimate) {
      ghost.style.left = `${pct(it.photoEstimate.low)}%`;
      ghost.style.width = `${pct(it.photoEstimate.high) - pct(it.photoEstimate.low)}%`;
    }
    nutr.replaceChildren(...(it.nutrients
      ? NUTRIENTS.map(([k, text, unit]) => el('span', {}, `${text} ${rangeText(it.nutrients[k], unit)}`))
      : [el('span', { class: 'muted' }, 'No food-database match yet: correct the food to price it.')]));
    actions.replaceChildren(...itemActions.map((fn) => fn({ item: it, ctx, update })).filter(Boolean));
    labelName.textContent = it.name;
    labelRange.textContent = g ? (g.low === g.high ? ` ${num(g.low)} g` : ` ${rangeText(g)} g`) : '';
    if (last && g && (last.low !== g.low || last.high !== g.high)) {
      li.classList.add('changed');
      setTimeout(() => li.classList.remove('changed'), 1200);
    }
    last = g && { low: g.low, high: g.high };
  }
  set(item);
  return { li, label, set };
}

// ---- stage: photo + outlines + labels ----
function buildStage(result, photoUrl) {
  const { width, height } = result.photo;
  const img = el('img', { src: photoUrl, alt: 'Meal photo', draggable: 'false' });
  const overlay = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: 'overlay', role: 'img', 'aria-label': 'Outlines of the measured items' });
  const labels = el('div', { class: 'labels' });
  const stage = el('figure', { class: 'stage', style: `--ar:${width}/${height}` }, img, overlay, labels);

  result.items.forEach((item, i) => {
    if (!item.mask) return;
    const p = svgEl('path', { d: item.mask.path, 'fill-rule': 'evenodd', class: item.mask.status === 'decoded' ? 'mask' : 'mask box', 'data-id': item.itemId });
    p.style.cssText = `--c:${colorOf(i)};--i:${i}`;
    overlay.append(p);
  });

  // Nudge labels apart (px space, after layout) so every one stays readable.
  const layout = () => {
    const W = stage.clientWidth, H = stage.clientHeight;
    const placed = [];
    for (const l of labels.children) {
      let x = parseFloat(l.dataset.x) / 100 * W, y = parseFloat(l.dataset.y) / 100 * H;
      const w = l.offsetWidth, h = l.offsetHeight;
      x = Math.max(4, Math.min(x, W - w - 4));
      y = Math.max(4, Math.min(y, H - h - 4));
      for (let guard = 0; guard < 24 && placed.some((p) => x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h); guard++) y += h + 3;
      y = Math.min(y, H - h - 4);
      placed.push({ x, y, w, h });
      l.style.left = `${x}px`;
      l.style.top = `${y}px`;
    }
  };
  return { stage, labels, layout };
}

function sumTiles(result) {
  return el('div', { class: 'sums' }, ...NUTRIENTS.map(([k, text, unit]) =>
    el('div', { class: 'sum' }, el('span', { class: 'k' }, text), el('strong', {}, rangeText(result.totals[k], unit)))));
}

function scaleCard(result) {
  const s = result.scale;
  if (!s) return null;
  if (s.status === 'unreadable') return el('section', { class: 'panel note-card' }, el('strong', {}, 'Scale display'), el('p', {}, 'The display could not be read. Enter grams for each item instead.'));
  if (s.status === 'unconfirmed') {
    return el('section', { class: 'panel note-card' }, el('strong', {}, 'Scale reading, not verified'),
      el('p', {}, `Read from the display: ${s.rawText} ${s.unit}. It is not used until you verify it.`));
  }
  return el('section', { class: 'panel note-card' }, el('strong', {}, 'Scale reading verified'), el('p', {}, `${num(s.grams)} g`));
}

export async function mountMeasure(root, ctx) {
  const pending = ctx.pending;
  ctx.pending = null;
  if (!pending && !ctx.result) { ctx.go('capture'); return; }

  const title = el('h1', {}, 'Measure');
  const status = el('p', { class: 'lede', role: 'status' }, 'Measuring…');
  const body = el('div', { class: 'measure-body' });
  root.append(el('section', { class: 'panel head-panel' }, title, status), body);

  let stageApi = null;
  let rows = [];
  const onResize = () => stageApi?.layout();
  window.addEventListener('resize', onResize);

  function render(result, photoUrl) {
    ctx.result = result;
    ctx.showMock(result.mock);
    status.textContent = result.items.length ? `${result.items.length} items measured` : 'Nothing identified in this photo.';
    body.replaceChildren();

    stageApi = buildStage(result, photoUrl);
    const list = el('ul', { class: 'items' });
    const extras = el('div', { class: 'extras' });
    const totals = el('section', { class: 'panel totals' });
    const notices = el('div', { class: 'notices' });
    const logBtn = el('button', { class: 'btn primary', type: 'button', disabled: !result.items.length }, 'Log this meal');
    const logErr = el('p', { class: 'err', role: 'alert', hidden: true });

    const refresh = (r) => {
      ctx.result = r;
      r.items.forEach((it) => rows.find((x) => x.id === it.itemId)?.row.set(it));
      totals.replaceChildren(el('h2', {}, 'Sum of ranges'), sumTiles(r),
        r.unmatched ? el('p', { class: 'muted' }, `${r.unmatched} item${r.unmatched > 1 ? 's' : ''} without a food-database match ${r.unmatched > 1 ? 'are' : 'is'} not in these sums.`) : null);
      notices.replaceChildren(
        ...r.warnings.map((w) => el('p', { class: 'notice' }, w.message)),
        ...r.modelErrors.map((m) => el('p', { class: 'notice' }, `The ${m.call.split('.')[0]} step did not complete (${m.kind}). Try again, or enter items by hand.`)),
      );
      extras.replaceChildren(scaleCard(r), ...resultPanels.map((fn) => fn({ result: r, ctx, update: refresh })).filter(Boolean));
    };

    rows = result.items.map((item, i) => ({ id: item.itemId, row: buildRow(item, i, ctx, refresh) }));
    rows.forEach(({ id, row }) => {
      const focus = (on) => {
        stageApi.stage.dataset.focus = on ? id : '';
        stageApi.stage.querySelectorAll('.mask').forEach((m) => m.classList.toggle('is-focus', on && m.dataset.id === id));
      };
      row.li.addEventListener('pointerenter', () => focus(true));
      row.li.addEventListener('pointerleave', () => focus(false));
      row.li.addEventListener('focusin', () => focus(true));
      row.li.addEventListener('focusout', () => focus(false));
      list.append(row.li);
      if (row.label) { row.label.dataset.x = parseFloat(row.label.style.left); row.label.dataset.y = parseFloat(row.label.style.top); stageApi.labels.append(row.label); }
    });
    refresh(result);

    logBtn.addEventListener('click', async () => {
      logBtn.disabled = true;
      logErr.hidden = true;
      try {
        await api.log(ctx.result.sessionId, today());
        ctx.go('log');
      } catch (e) {
        logErr.textContent = `Not logged yet: ${e.message}`;
        logErr.hidden = false;
        logBtn.disabled = false;
      }
    });

    body.append(
      el('div', { class: 'measure-grid' },
        el('div', { class: 'stage-col' }, stageApi.stage),
        el('div', { class: 'side-col' }, notices, list, totals, extras,
          el('div', { class: 'row' }, logBtn, el('a', { class: 'btn', href: '#/capture' }, 'New photo')), logErr)),
    );
    // Reveal in sequence once the first frame is laid out: outlines, labels, rows.
    const img = stageApi.stage.querySelector('img');
    const go = () => { stageApi.layout(); requestAnimationFrame(() => body.classList.add('in')); };
    if (img.complete) go(); else { img.addEventListener('load', go, { once: true }); img.addEventListener('error', go, { once: true }); }
  }

  try {
    const request = pending
      ? await run(pending)
      : { result: ctx.result, photoUrl: ctx.result.photo.url ?? ctx.photoUrl };
    ctx.photoUrl = request.photoUrl;
    render(request.result, request.photoUrl);
  } catch (e) {
    status.replaceChildren(el('span', { class: 'err' }, `Could not measure: ${e.message}`), ' ', el('a', { href: '#/capture' }, 'Try again'));
  }

  return () => window.removeEventListener('resize', onResize);

  async function run(p) {
    const result = await api.measure(p.sample ? { sample: p.sample, mock: true } : { image: p.photo.base64 });
    const photoUrl = result.photo.url ?? p.photo.url;
    if (p.scale || result.scaleAvailable) {
      try { Object.assign(result, (await api.scaleOcr({ sessionId: result.sessionId, image: p.scale?.base64 })).entry); } catch { /* the reading is optional */ }
    }
    return { result, photoUrl };
  }
}
