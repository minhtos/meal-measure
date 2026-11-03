# meal-measure

Photo food-measurement tool: photo → Meta SAM segmentation → Meta Spark food
identification → portion (scale weight or photo estimate as a range) →
nutrients computed by code from USDA FoodData Central / Open Food Facts →
user corrections → log with per-item source and confidence → plain day-view sums.

Meta Global AI Developer Hackathon entry (build window 2026-10-27 to 2026-11-04).

## Setup

No installs. Requires Node.js 22.

Meta API access is bring-your-own-key: set the key in your environment (see
`docs/INTEGRATION.md` → Configuration). Without a key the app runs in mock mode
against recorded sample runs.

Copy `.env.example` to `.env` and fill in your keys to run live. The
recorded samples carry their provenance (`data/samples/*/provenance.json`),
so the keyless mode is fully inspectable.

**Barcode lookup (optional).** Barcode entry runs against a local Open
Food Facts import — the data files are not in the repo. Download the
Open Food Facts CSV export (tab-separated; a `.gz` export works too) and
run `node scripts/import-off.mjs <products.csv>` once: it builds
`data/off-us.jsonl` and `data/off-us.index.json` (US products only,
git-ignored). Without this step, barcode entry reports itself unavailable
and everything else works.

## Run the app

```bash
node server.mjs                  # http://127.0.0.1:8787  (PORT, HOST to change)
```

A dependency-free static PWA (`web/`) served by `server.mjs` (node:http only).

- **Mock vs live.** Mock is the default when `META_API_KEY` is not in the server's
  environment (or `MEAL_MEASURE_MODE=mock`): the recorded samples (`tacos-meal004`,
  `pho-meal005`) are replayed through the real pipeline, and the UI shows a `mock data`
  chip. With a key the server runs the live pipeline; the key stays in the server process
  and is never sent to the browser. `?mock=1` on `/api/measure` (or the "Try a recorded
  sample" buttons) forces mock even with a key.
- **API.** `POST /api/measure`, `/api/scale-ocr`, `/api/anchor`, `/api/log`,
  `GET /api/day`, `GET /api/config`. The browser only ever talks to these.
- **Day log** persists to `data/day-log.json` (git-ignored; `MEAL_MEASURE_LOG` overrides).

## Design

- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — Meta model-call contracts,
  module boundaries, and the smoke tests that enforce the logging rules.

## Verify

```bash
./scripts/verify
```

## Data sources

Nutrient data: USDA FoodData Central (public domain, via API). Packaged-food data: Open Food Facts (https://world.openfoodfacts.org), available under the Open Database License (ODbL). Benchmark method and results: see BENCHMARK.md. Barcode lookup is local: download the Open Food Facts CSV export and run
`node scripts/import-off.mjs <products.csv>` once to build the index;
without that step the barcode entry reports itself unavailable and
everything else works. Repo provenance: see PROVENANCE.md.
