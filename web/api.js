// The only way the front end reaches the pipeline: the server's JSON endpoints.
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  config: () => call('GET', '/api/config'),
  // { image } live photo (base64 JPEG) | { sample } recorded sample; mock forces recorded data
  measure: ({ image, sample, mock }) => call('POST', `/api/measure${mock ? '?mock=1' : ''}`, { image, sample, mock }),
  scaleOcr: ({ sessionId, image }) => call('POST', '/api/scale-ocr', { sessionId, image }),
  anchor: (sessionId, itemId, grams) => call('POST', '/api/anchor', { sessionId, itemId, grams }),
  log: (sessionId, day) => call('POST', '/api/log', { sessionId, day }),
  correct: (sessionId, itemId, change) => call('POST', '/api/correct', { sessionId, itemId, ...change }), // { name } and/or { grams }
  selectCandidate: (sessionId, itemId, candidateId) => call('POST', '/api/select-candidate', { sessionId, itemId, candidateId }),
  refine: (sessionId, itemId, points) => call('POST', '/api/refine', { sessionId, itemId, points }),
  scaleConfirm: (sessionId, body) => call('POST', '/api/scale-confirm', { sessionId, ...body }), // { value, unit, secondary, itemId } | { decision }
  barcode: (code, grams) => call('POST', '/api/barcode', { code, grams }),
  quickMeals: () => call('GET', '/api/quick-meals'),
  logQuickMeal: (quickId, day) => call('POST', '/api/quick-meals/log', { quickId, day }),
  benchmark: () => call('GET', '/benchmark.json'),
  day: (day) => call('GET', `/api/day?day=${encodeURIComponent(day)}`),
};
