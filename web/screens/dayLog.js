// Day log: logged entries for one day, plain sums with ranges, per-item source / confidence tags.
import { api } from '../api.js';
import { el, rangeText, gramsText, today, NUTRIENTS } from '../util.js';

const CONF = { low: 'low confidence', high: 'higher confidence' };
const tag = (t) => el('span', { class: 'tag' }, t);

const sums = (totals) => el('div', { class: 'sums' }, ...NUTRIENTS.map(([k, text, unit]) =>
  el('div', { class: 'sum' }, el('span', { class: 'k' }, text), el('strong', {}, rangeText(totals[k], unit)))));

function itemRow(i) {
  const t = i.tags;
  return el('li', { class: 'log-item' },
    el('div', { class: 'log-main' }, el('strong', {}, i.name), el('span', { class: 'grams' }, gramsText(i.grams))),
    el('div', { class: 'tags' },
      tag(t.portion), t.portionConfidence in CONF ? tag(CONF[t.portionConfidence]) : null,
      tag(t.food), typeof t.foodConfidence === 'number' ? tag(`identified ${Math.round(t.foodConfidence * 100)}%`) : tag('confirmed'),
      t.database ? tag(`data: ${t.database}`) : null),
    el('p', { class: 'nutr' }, ...NUTRIENTS.map(([k, text, unit]) => el('span', {}, `${text} ${rangeText(i.nutrients[k], unit)}`))));
}

const shift = (day, n) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

export async function mountDayLog(root, ctx) {
  const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.get('day') ?? '') ? query.get('day') : today();
  const nav = (n) => { location.hash = `#/log?day=${shift(day, n)}`; };

  root.append(el('section', { class: 'panel head-panel' },
    el('h1', {}, 'Day log'),
    el('div', { class: 'daynav' },
      el('button', { class: 'btn small', type: 'button', 'aria-label': 'Previous day', onclick: () => nav(-1) }, '‹'),
      el('strong', {}, day === today() ? `Today · ${day}` : day),
      el('button', { class: 'btn small', type: 'button', 'aria-label': 'Next day', onclick: () => nav(1) }, '›'))));

  let data;
  try { data = await api.day(day); } catch (e) {
    root.append(el('p', { class: 'err' }, `Could not load the log: ${e.message}`));
    return;
  }
  if (!data.entries.length) {
    root.append(el('section', { class: 'panel' }, el('p', { class: 'lede' }, 'Nothing logged for this day yet.'), el('a', { class: 'btn primary', href: '#/capture' }, 'Measure a meal')));
    return;
  }
  root.append(
    el('section', { class: 'panel totals' }, el('h2', {}, 'Day sums (ranges)'), sums(data.totals)),
    ...data.entries.map((e) => el('section', { class: 'panel' },
      el('div', { class: 'log-head' }, el('strong', {}, new Date(e.loggedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })), sums(e.totals)),
      el('ul', { class: 'log-items' }, ...e.items.map(itemRow)))),
  );
}
