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

## Design

- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — Meta model-call contracts,
  module boundaries, and the smoke tests that enforce the logging rules.

## Verify

```bash
./scripts/verify
```

## Data sources

Nutrient data: USDA FoodData Central (public domain, via API). Packaged-food data: Open Food Facts (https://world.openfoodfacts.org), available under the Open Database License (ODbL). Benchmark method and results: see BENCHMARK.md. Repo provenance: see PROVENANCE.md.
