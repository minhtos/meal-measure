// Tiny DOM helpers. Text always goes in as text nodes, never as HTML.
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((c) => c != null && c !== false));
  return n;
}

export const svgEl = (tag, props = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) n.setAttribute(k, v);
  return n;
};

export const num = (v) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
export const rangeText = (b, unit = '') => (b.low === b.high ? `${num(b.low)}${unit}` : `${num(b.low)}–${num(b.high)}${unit}`);
export const gramsText = (g) => (g ? `${rangeText(g)} g` : 'no estimate');

export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

export const NUTRIENTS = [['kcal', 'kcal', ''], ['protein', 'protein', ' g'], ['carbs', 'carbs', ' g'], ['fat', 'fat', ' g']];
