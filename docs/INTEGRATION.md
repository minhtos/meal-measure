# meal-measure — Meta integration design

Status: design, 2026-10-29. No app code yet. This document is the contract the
first code PRs implement and the smoke tests enforce. Scope is frozen
(hackathon build window 2026-10-27 to 2026-11-04); defaults chosen without a
live answer from Minh are marked **Default** and collected in §12.

meal-measure is a food-**measurement** tool: it estimates, measures, logs, and
lets the user verify and correct. It is not a nutrition coach.

---

## 1. Stack decision

- **Dependency-free Node.js ESM, Node 22**, tests with `node:test`. Contracts,
  validators, the nutrient layer, the pipeline, mock mode, and smoke tests run
  with zero installs (`./scripts/verify`).
- HTTP via the built-in `fetch`; hashing via `node:crypto`; env via
  `process.env` (loaded with `node --env-file=...`, see §10).
- The PWA front end attaches later and calls the pipeline layer only. It never
  calls `src/model/` or `src/nutrition/` directly.

## 2. Pipeline and where each Meta call sits

```
photo
  │  (code: strip EXIF, downscale to ≤1536 px long edge, sha256)
  ▼
[B1] SAM coarse pass ── dish/plate mask ─────────────┐
  ▼                                                  │
[B2] SAM item pass ──── candidate item regions r1..rn┤  (src/model/sam.js)
  ▼                                                  │
[A]  Spark identification (photo + numbered region overlay)   (src/model/spark.js)
  │     items: name, alternatives, gram range, confidence, regionId|null, bbox
  ▼
[B3] SAM refine pass ── box prompt for items with regionId=null; else mask-less
  ▼
portion per item:
  • user-entered grams (anchor, HIGH)               ── no model call
  • scale photo → [C] scale OCR → user CONFIRMS     (src/model/scaleOcr.js)
        → code converts unit → anchor
  • otherwise Spark gram range (photo estimate, LOW)
  ▼
food match: item name → USDA FDC / Open Food Facts record (code search, user-correctable)
  ▼
nutrients = grams × per-100g / 100   ── CODE ONLY (src/nutrition/)
  ▼
user corrections (food, portion, mask) → recompute by code
  ▼
log entry (per-item source + confidence + provenance) → day view: plain sums
```

## 3. The model never calculates nutrient numbers

**The model never calculates nutrient numbers.** No Meta model call is asked
for, and no Meta model response is allowed to supply, energy, macronutrient,
or micronutrient values.

- All nutrient math is code over USDA FoodData Central or Open Food Facts
  data: `nutrient = grams × per100g[nutrient] / 100`, in `src/nutrition/`.
- Prompts to Spark never request nutrients. Response validators in
  `src/model/` **drop** any nutrient-like key (`calories`, `kcal`, `energy`,
  `protein`, `fat`, `carb*`, `sugar*`, `fiber`, `sodium`, `nutrients`, …)
  and record `strippedNutrientFields: true` in provenance. A smoke test feeds a
  poisoned mock response and asserts nothing reaches the entry.
- `src/model/` never imports `src/nutrition/` and vice versa (enforced by a
  test that scans import specifiers). Only `src/pipeline/` joins grams to a
  database record.
- Every logged nutrient value carries the database record it came from
  (`db`, `id`, `dataType`, `fetchedAt`). A nutrient without a database source
  cannot be constructed.

## 4. Module boundary

```
src/
  model/          Meta calls only. Knows images, prompts, JSON schemas. No nutrients.
    index.js        public entry point of the model layer (what pipeline/ imports)
    client.js       fetch wrapper: auth header, timeout, retry, redaction, live|mock switch
    spark.js        identifyFoods(image, regions)        → contract A
    sam.js          segmentDish / segmentItems / refine  → contract B
    scaleOcr.js     readScale(image)                     → contract C
    validate.js     hand-written schema checks + nutrient-key stripping
    mock.js         replays data/samples/<id>/*.json keyed by image sha256
  nutrition/      Databases and arithmetic only. Knows nothing about models.
    usda.js         FDC search + food detail (per-100g normalisation)
    off.js          LOCAL Open Food Facts lookup by barcode over the bulk import (§4.1)
    compute.js      computeNutrients(per100g, grams{low,likely,high}) → numbers
    units.js        toGrams(value, unit) — g, kg, oz, lb, lb+oz; volume refused
  pipeline/       The rules. The only layer that imports both.
    session.js      one photo → items → entries; state machine below
    rules.js        correction / anchor / confirmation / divergence / tare rules
    log.js          append-only day log (JSON file per day) + day sums
data/
  samples/<id>/   recorded live runs with provenance (§10)
  fixtures/       nutrition fixtures for mock mode and tests
test/
  smoke.test.js   §11
  boundary.test.js
```

### 4.1 UPC / barcode lookup

Packaged-food scans resolve from **local data**, not a per-scan web query.

1. **Import (one time).** `node scripts/import-off.mjs <products.csv.gz>`
   streams an Open Food Facts bulk CSV export, keeps rows whose
   `countries_tags` include `en:united-states` with a usable name and kcal
   (`energy-kcal_100g`, else `energy_100g` kJ ÷ 4.184), and writes
   `data/off-us.jsonl` plus `data/off-us.index.json` (code → byte offset).
   `data/` is gitignored.
2. **Lookup.** `src/nutrition/off.js` seeks one line via the index. Codes are
   normalised (UPC-A 12 / EAN-13 / GTIN-14 zero-padding variants).
3. **Fallback.** Only on a local miss, `src/nutrition/usda.js` searches USDA
   FoodData Central branded foods by GTIN (needs `USDA_API_KEY`; without it the
   fallback is skipped and the local miss stands).
4. **Honest results.** `src/pipeline/barcode.js` `resolveUpc` returns
   `matched` (source `off-local` | `usda-branded`, per-100g, code-computed
   nutrients when grams are known), `unmatched` (a data fact), or
   `lookup-failed` (USDA HTTP/rate-limit error — never reported as unmatched).
5. **No anonymous per-scan OFF query exists.** The public OFF API rate-limits
   into false "not found"; the only OFF data path is the bulk import.

Check real data after importing: `node scripts/test-upcs.mjs <upc...>`.

## 5. Common envelope for every model call

```json
{
  "ok": true,
  "data": { "...contract-specific..." },
  "error": null,
  "provenance": {
    "call": "spark.identify | sam.dish | sam.items | sam.refine | scale.ocr",
    "mode": "live | mock",
    "model": "model id string reported by the API, or 'mock'",
    "requestId": "string | null",
    "inputSha256": "hex of the image bytes sent",
    "at": "ISO-8601",
    "latencyMs": 0,
    "sampleId": "string | null (mock only)",
    "strippedNutrientFields": false
  }
}
```

On failure: `ok: false`, `data: null`,
`error: { "kind": "no_key | auth | timeout | http | schema | unreadable", "message": "redacted text", "retryable": bool }`.
The client never throws past the pipeline; each contract defines its fallback.

Client defaults (**Default**): timeout 20 s (SAM 30 s), one retry on timeout or
5xx, one retry on schema failure with the same input, no retry on 4xx. API keys
and `Authorization` headers are never included in errors, logs, or provenance.

---

## 6. Contract A — Spark photo food identification

**Position:** after SAM passes B1/B2, before B3. Called once per meal photo;
called again on a crop only when the user taps an unidentified region and
asks for an estimate (§7, tap-to-correct).

**Input**

```json
{
  "image": "<JPEG bytes, EXIF stripped, ≤1536 px>",
  "regionOverlay": "<same image with numbered region outlines r1..rn, or null if SAM failed>",
  "regions": [ { "regionId": "r1", "bbox": [0.12, 0.30, 0.25, 0.20] } ],
  "locale": "en-US"
}
```

`bbox` is normalised `[x, y, w, h]` in 0–1. The prompt asks for identification,
grams range, and context signals in the JSON shape below — and states that
nutrient values must not be returned.

**Output (`data`)**

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "itemId": "i1",
      "regionId": "r2",
      "name": "cooked white rice",
      "preparation": "boiled | fried | raw | ... | null",
      "alternatives": [
        { "name": "jasmine rice, cooked", "confidence": 0.21 },
        { "name": "cauliflower rice", "confidence": 0.06 }
      ],
      "grams": { "low": 120, "likely": 160, "high": 210 },
      "confidence": 0.72,
      "bbox": [0.40, 0.35, 0.22, 0.18]
    }
  ],
  "context": {
    "container": { "type": "plate | bowl | box | cup | wrapper | none", "confidence": 0.8 },
    "brandMarks": [ { "text": "Chobani", "confidence": 0.65 } ],
    "placeHint": { "text": "fast-food tray", "confidence": 0.4 },
    "scaleVisible": false
  }
}
```

**Validation (code):** `name` non-empty; `confidence` 0–1;
`0 < low ≤ likely ≤ high`, `high ≤ 3000`; at most 5 alternatives; unknown keys
dropped; nutrient-like keys stripped (§3). An item that fails only the grams
check is kept with `grams: null` → state `needs_portion`. `regionId` that does
not exist → set to `null`.

**Range middle:** the logged photo-estimate value is the range middle. Code
sets `likely = round((low + high) / 2)`; the model's own `likely` is kept in
provenance only. (**Default** — makes "range middle" deterministic.)

**Context signals are confidence-only.** `container`, `brandMarks`,
`placeHint`, `scaleVisible` may:
- raise or lower displayed identification confidence;
- reorder food-database candidates (e.g. a brand mark puts matching Open Food
  Facts branded products first in the pick list);
- trigger the tare check (§8) or a prompt to add a scale photo.

They never set grams, never set nutrients, and never auto-select a database
record without it being shown to the user. `placeHint` comes from image
content only — EXIF/GPS is stripped before the call and no location is stored.

**Failure / fallback**
- `no_key` / `auth` → fall back to mock mode only if `MEAL_MEASURE_MODE=auto`
  and a recorded sample matches; otherwise the session enters `manual`:
  user types food names; portion from user grams or scale.
- `timeout` / `http` / `schema` after retry → `manual`, masks (if any) remain
  tappable so the user can name each region.
- `items: []` → "Nothing identified" state with "Add item" (manual name).

**Mock mode:** returns `data/samples/<id>/spark.json` whose `inputSha256`
matches the photo. Unknown photo → `items: []` with `provenance.mode: "mock"`,
exercising the manual path. A fixture `data/fixtures/spark-poisoned.json`
contains nutrient keys for the stripping test.

**User correction:** every item exposes its `alternatives` plus free-text
search. A correction replaces `name` (source → `user-corrected`, identification
confidence → `confirmed`), re-runs the food match, and **recomputes nutrients
for the corrected food at the same portion**. The corrected entry is what is
logged; the original Spark name is kept in provenance.

---

## 7. Contract B — SAM segmentation (coarse-to-fine)

**Position:** first model calls on the photo (B1, B2) and one refine pass
after Spark (B3); also on demand from tap-to-correct.

**Input (all passes)**

```json
{
  "image": "<same bytes as Spark>",
  "prompts": {
    "points": [ { "x": 0.5, "y": 0.5, "label": 1 } ],
    "boxes":  [ [0.05, 0.05, 0.90, 0.90] ]
  },
  "multimask": true
}
```

Points/boxes normalised 0–1; `label` 1 = include, 0 = exclude. The adapter
converts to whatever coordinate convention the hosted SAM endpoint expects.

**Output (`data`)**

```json
{
  "masks": [
    {
      "maskId": "m3",
      "rle": { "size": [1152, 1536], "counts": "COCO-RLE string" },
      "bbox": [0.38, 0.33, 0.25, 0.21],
      "areaFrac": 0.084,
      "score": 0.91
    }
  ]
}
```

**Coarse-to-fine prompting**
1. **B1 dish pass:** one box prompt covering the central 90 % of the image plus
   a centre point. Pick the highest-score mask with `areaFrac` 0.10–0.95 as
   the dish/plate region. None qualifies → dish = whole image, flag
   `noDishMask` (not an error).
2. **B2 item pass:** a 4×4 point grid restricted to the dish mask (**Default**).
   Keep masks with `score ≥ 0.6`, `areaFrac` ≥ 1 % of the dish, not ≈ the dish
   itself (IoU < 0.9); de-duplicate at IoU > 0.8 keeping the higher score.
   Survivors become regions `r1..rn` for Spark's overlay.
3. **B3 refine pass:** for each Spark item with `regionId: null` and a `bbox`,
   send a box prompt. Accept if `score ≥ 0.5` and IoU with the bbox ≥ 0.3.

**Mask-less items — a supported state.** An item whose mask cannot be found
has `mask: null` and
`maskStatus: "none"` with `maskReason: "not_found | low_score | sam_unavailable | user_cleared"`.
It is listed, correctable, portionable, and loggable like any other item; the
UI shows it as a list row without an outline. Masks are used for display,
tap targeting, and the overlay sent to Spark — never for nutrient numbers.

**Tap-to-correct hook** (pipeline API, UI attaches later):
- `pipeline.tap(sessionId, {x, y})` → returns the item whose mask contains the
  point, or `{ unassigned: true }`.
- `pipeline.refineMask(sessionId, itemId, {x, y, label})` → re-runs SAM with
  the item's previous prompts plus the new point (include/exclude) and replaces
  the mask; failure leaves the previous mask untouched.
- `pipeline.addItemAt(sessionId, {x, y})` → SAM point prompt creates a mask;
  the user names the item (or requests a Spark call on the crop, contract A).
- `pipeline.clearMask(sessionId, itemId)` → mask-less with `user_cleared`.

**Failure / fallback:** any SAM failure → all items mask-less with
`sam_unavailable`; Spark is called with `regionOverlay: null`; the pipeline
continues. SAM never blocks logging.

**Mock mode:** replays `data/samples/<id>/sam-{dish,items,refine}.json` by
image hash; unknown photo → `masks: []` (exercises the mask-less path).
Tap/refine in mock mode returns the recorded mask nearest to the tap, if any.

---

## 8. Contract C — Scale-weight OCR with confirmation gate

**Position:** optional, when the user adds a photo of a scale display (or
Spark reports `scaleVisible: true` and the user agrees to read it). Runs as a
Spark vision call with an OCR-only prompt.

**Input**

```json
{ "image": "<photo or crop of the scale display>", "expectUnits": ["g", "kg", "oz", "lb"] }
```

**Output (`data`)**

```json
{
  "reading": {
    "rawText": "0.352 kg",
    "value": 0.352,
    "unit": "g | kg | oz | lb | lb_oz | ml | null",
    "secondary": { "value": 4.2, "unit": "oz" },
    "flags": { "tareIndicator": true, "stable": null, "negative": false },
    "confidence": 0.88
  },
  "status": "unconfirmed"
}
```

`secondary` is only for `lb_oz` displays (e.g. `1 lb 4.2 oz`); otherwise null.

**Rules (code, `src/pipeline/rules.js` + `src/nutrition/units.js`)**
- The model's reading is **always `status: "unconfirmed"`**, whatever the model
  returns. Only the pipeline can move it to `confirmed`, and only from an
  explicit user action `confirmScale(sessionId, readingId, {value, unit})`
  (the user may edit either field; edits are recorded).
- An unconfirmed reading **cannot be logged and cannot be used as an anchor**.
  `toAnchor()` and `logEntry()` throw `UnconfirmedScaleReadingError` on it.
  It is never applied silently, even at confidence 1.0.
- Code independently parses `rawText`. If the parsed value/unit disagrees with
  the model's `value`/`unit`, the reading is marked `disagreement: true` and
  the UI shows the raw text with empty fields for the user to fill.
- `unit: null` → the user must pick a unit before confirming.
- **Unit conversion is code, explicit:** `g × 1`, `kg × 1000`,
  `oz × 28.349523125`, `lb × 453.59237`, `lb_oz = lb × 453.59237 + oz × 28.349523125`.
  `ml` (volume) is refused as an anchor — the user is asked to enter grams
  (**Default**: no density guessing). Negative or zero values are refused.
- **Divergence:** compare confirmed grams `G` with the photo range sum
  `[ΣL, ΣH]` of the items it covers. Plausible if
  `0.75·ΣL ≤ G ≤ 1.33·ΣH` (**Default**). Otherwise both values are presented
  with code-templated plausibility reasoning, e.g. "Scale: 612 g. Photo
  estimate: 280–390 g. A plate often weighs 300–600 g — if it was on the
  scale, tare it or subtract its weight." The user picks: use scale, use photo
  estimate, or enter grams. No automatic choice.
- **Tare warning:** shown when `G − ΣH ≥ 100 g` and Spark reports a
  container (`plate | bowl | box | cup`), or when `flags.tareIndicator` is
  `false`/`null` and a container is visible. Warning only; the user decides.
- **Multiple items on one scale reading:** total is distributed across items
  in proportion to their range middles; source `scale-distributed`,
  confidence `medium` (**Default**). A single item gets the full weight,
  source `scale-confirmed`, confidence `high`.

**Failure / fallback:** unreadable display or call failure →
`status: "unreadable"`; the user types grams (source `user-entered`, `high`).

**Mock mode:** replays `data/samples/<id>/scale-ocr.json`; unknown image →
`unreadable`. Mock readings are still `unconfirmed` and go through the same gate.

---

## 9. Portion, source, and confidence model (pipeline)

| Portion source        | How                                   | Logged grams          | Portion confidence |
|-----------------------|---------------------------------------|-----------------------|--------------------|
| `user-entered`        | user types grams for the item         | that value            | high               |
| `scale-confirmed`     | confirmed OCR or typed scale value, 1 item | converted grams  | high               |
| `scale-distributed`   | confirmed scale total over n items    | proportional share    | medium             |
| `photo-estimate`      | Spark range (mask present)            | range middle          | low                |
| `photo-estimate`      | Spark range, mask-less item           | range middle          | low (flag `maskless`) |

- A user anchor **overrides** the photo estimate; the photo range stays in
  provenance for display ("photo estimate was 120–210 g").
- Nutrients are computed for `low`, `likely`, and `high` grams; anchored
  items have `low = likely = high`.
- Identification confidence is separate: Spark score, or `confirmed` after a
  user correction or explicit accept.

**Log entry shape**

```json
{
  "entryId": "uuid", "loggedAt": "ISO-8601", "sessionId": "uuid",
  "food": { "name": "jasmine rice, cooked", "source": "spark | user-corrected",
            "identificationConfidence": 0.72, "originalModelName": "cooked white rice" },
  "portion": { "grams": { "low": 120, "likely": 165, "high": 210 }, "loggedGrams": 165,
               "source": "photo-estimate", "confidence": "low", "mask": "present | none" },
  "nutrientSource": { "db": "usda-fdc | off", "id": "<FDC id or OFF barcode>", "dataType": "SR Legacy",
                      "fetchedAt": "ISO-8601" },
  "nutrients": { "energy_kcal": { "low": 156, "likely": 215, "high": 273 } },
  "provenance": { "calls": [ "<envelope.provenance objects>" ], "codeVersion": "git sha" }
}
```

Day view: plain sums of `loggedGrams`-based nutrient values for the day, plus
the summed low–high range. No targets, no comparisons.

## 10. Configuration, bring-your-own key, mock mode, sample runs

| Variable              | Purpose                                             |
|-----------------------|-----------------------------------------------------|
| `META_API_KEY`        | Meta API key (BYO). Absent → no live model calls.   |
| `META_API_BASE_URL`   | Endpoint base (hackathon default set in code).      |
| `META_SPARK_MODEL`, `META_SAM_MODEL` | model ids (defaults set in code once confirmed) |
| `USDA_API_KEY`        | FDC key. Absent → USDA `DEMO_KEY` (rate-limited).   |
| `MEAL_MEASURE_MODE`   | `live` · `mock` · `auto` (default: live if key present, else mock) |

- Keys are read from `process.env` only. On this VM they live in
  `~/.config/meta-api.env` and `~/.config/usda-api.env` (mode 600) and are
  loaded by the run command, e.g. `node --env-file=$HOME/.config/meta-api.env ...`.
  Code and agents never read, print, commit, or echo key values.
  `.env` / `.env.*` are gitignored; `.env.example` lists variable names only.
- Judges set `META_API_KEY` in their own env (or the PWA settings screen later)
  to run live after the event.
- **Recorded sample runs** ship in `data/samples/<id>/`: `photo.jpg`,
  `sam-*.json`, `spark.json`, optional `scale-ocr.json`, and
  `provenance.json` = `{ recordedAt, mode: "live", models, requestIds,
  inputSha256, codeVersion, recordedBy }`. Recorded responses are stored
  verbatim (post-redaction); no keys or headers are recorded.
- Mock mode is deterministic, offline, and is what `./scripts/verify` runs.
  The UI shows a visible "mock data" label in mock mode.

## 11. Smoke tests (`test/smoke.test.js`, run by `./scripts/verify`)

All run in mock mode with nutrition fixtures; no network, no keys.

1. **A user correction changes the resulting entry.** Sample photo → Spark
   mock identifies "cooked white rice", photo range 120–210 g. Build entry
   E1. Apply `correctFood(item, "cooked quinoa")`. Build entry E2. Assert:
   `E2.food.name` is quinoa, `E2.food.source === "user-corrected"`,
   `E2.portion.loggedGrams === E1.portion.loggedGrams` (same portion),
   `E2.nutrientSource.id !== E1.nutrientSource.id`, `E2.nutrients` equal
   `fixtureQuinoaPer100g × grams / 100` and differ from E1, and the logged
   entry is E2.
2. **A portion anchor override changes the resulting entry.** Same item;
   `setUserGrams(item, 250)`. Assert `loggedGrams === 250` (not the range
   middle 165), `portion.source === "user-entered"`,
   `portion.confidence === "high"` (photo estimate was `low`), nutrients
   recomputed for 250 g, photo range kept in provenance.
3. **An unconfirmed scale weight cannot be logged.** Scale-OCR mock returns
   `352 g`. Assert `logEntry` with that reading as anchor throws
   `UnconfirmedScaleReadingError` and the day log is unchanged; a mock
   response claiming `status: "confirmed"` is still treated as unconfirmed.
   After `confirmScale(...)`, logging succeeds with `source: "scale-confirmed"`.

Supporting tests:
- `boundary.test.js`: no file in `src/model/` imports `src/nutrition/` or
  vice versa.
- Poisoned Spark fixture with `calories`/`protein` keys → stripped, flagged in
  provenance, entry nutrients equal the fixture-database computation.
- Mask-less item (SAM mock returns no masks) logs normally with `mask: "none"`.
- `toGrams` table: kg, oz, lb, lb_oz exact; `ml` refused.

## 12. Defaults chosen and open points

Defaults (pre-approved frozen scope; chosen without a live answer):
- Range middle = `round((low + high) / 2)` computed by code; model `likely` kept in provenance.
- SAM: dish box = central 90 %; item grid 4×4 inside the dish mask;
  thresholds score ≥ 0.6 (items), ≥ 0.5 (refine), dedupe IoU 0.8.
- Scale divergence band `0.75·ΣL … 1.33·ΣH`; tare warning at `≥ 100 g` over ΣH with a container.
- Multi-item scale totals distributed proportionally, confidence `medium`.
- Volume units are refused as anchors (no density guessing).
- Scale OCR is a Spark vision call with an OCR prompt (no separate OCR model).
- Client timeouts 20 s / 30 s, one retry.
- Food match: USDA FDC first (Foundation → SR Legacy → Survey FNDDS), Open
  Food Facts first when a brand mark or barcode is present; the match is
  always shown and correctable.
- Day log stored as one JSON file per day under a local data dir (no server DB).
- `MEAL_MEASURE_MODE=auto` default; `DEMO_KEY` for USDA when no key is set.

Open points (do not block this design; resolved when the first live call is made):
- Exact hosted endpoint paths, auth header, and model ids for Spark and SAM
  in the hackathon API — isolated in `src/model/client.js` and the adapters.
- Whether hosted SAM returns RLE or polygons — the adapter normalises to RLE.

## 13. Product copy vocabulary

All user-facing strings use: measure, log, verify, estimate, range, correct.
Banned in product copy: coach, coaching, advice, recommend, should eat,
healthy/unhealthy as judgments, diet plan. Out of scope and not scaffolded:
targets, BMR/TDEE, macro presets, progress-vs-target, weekly target
summaries, drift alerts.
