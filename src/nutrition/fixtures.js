// TEST FIXTURES — a tiny offline per-100g table so smoke tests run without
// network or keys. Values are rounded from USDA FoodData Central entries for the
// named foods but have NOT been re-verified against live FDC records; the
// phở broth row is an approximate homemade-style figure. Not for real logging.
export const FIXTURE_LABEL = 'TEST FIXTURE — approximate USDA-derived values, offline use only';

const TABLE = [
  { id: 'fixture:ground-beef-90-10', name: 'ground beef 90/10, raw', match: ['ground beef', 'beef 90'], per100g: { kcal: 176, protein: 20, carbs: 0, fat: 10 } },
  { id: 'fixture:ground-turkey-breast', name: 'ground turkey breast, raw', match: ['ground turkey', 'turkey breast'], per100g: { kcal: 120, protein: 24, carbs: 0, fat: 2 } },
  { id: 'fixture:white-rice-cooked', name: 'white rice, cooked', match: ['white rice', 'cooked rice', 'rice'], per100g: { kcal: 130, protein: 2.7, carbs: 28.2, fat: 0.3 } },
  { id: 'fixture:pho-broth', name: 'phở-style broth', match: ['pho', 'phở', 'broth'], per100g: { kcal: 14, protein: 1.2, carbs: 1, fat: 0.5 } },
];

export function lookupFixture(foodName) {
  const n = foodName.toLowerCase();
  const hit = TABLE.find((row) => row.match.some((m) => n.includes(m)));
  return hit ? { id: hit.id, name: hit.name, per100g: { ...hit.per100g }, label: FIXTURE_LABEL } : null;
}
