# Energy evidence used by the squad builder

Both `index.html` and `mfl-squad-organiser.html` request the same player profiles from two completed collections. They use the pooled evidence for the starting-XI planner and the optional **Update energy drain** scan.

| Collection | Match dates (UTC, inclusive) | Match pairs |
| --- | --- | ---: |
| [Original August collection](https://mfl-energy-crawler.ricky-hyde-selling.workers.dev/api/dashboard) | 12–29 August 2026 | 842,353 |
| [July–August collection](https://mfl-energy-crawler-jul-aug-2026.ricky-hyde-selling.workers.dev/api/dashboard) | 1 July–5 August 2026 | 1,199,939 |

Collection status and matching rules were checked on 2 September 2026. The source pool contains **2,042,292 match pairs**. Each profile uses only its matching, usable observations; this total is not the sample size of every prediction. Both collections compare consecutive starting-XI appearances at most 30 hours apart.

The windows do not overlap. This matters because the model endpoints return aggregates rather than match-pair identifiers. Future overlapping collections must be deduplicated upstream before pooling.

## How pooling works

- POST the existing profile batch to `/api/energy-models` on each service, in parallel.
- Combine observations at the same raw starting energy using `sum(averageDrainRaw * sampleSize) / sum(sampleSize)`. Keep decimal precision until the existing per-match prediction rounds the result.
- Keep standard and widened observations separate. Use the pooled standard evidence within ±300 raw energy first; use the pooled widened evidence only when no standard observation matches.
- Retain the existing OVR/physical ranges, exact retirement matching, merged positions, training recovery and manual drain overrides. Both services reported identical matching rules.
- If one service fails or times out, the planner can use the available source and identifies the missing collection. Partial evidence is eligible for retry after 60 seconds when the planner next renders. It never replaces an already complete cached model or becomes a completed saved pool scan.
- Saved projection counts use the `mfl_energy_projection_counts_v2_` prefix, so old single-collection counts are ignored. Run **Update energy drain** to populate the player list from the combined pool.

## Verification and publishing

Run `node --test MFL-Squad-Organiser/tests/energy-pool.test.cjs` from the workspace root. The tests cover sample weighting, standard/widened precedence, outages, retries, cache invalidation and consistency between planner and scan calculations.

A live browser check queried both services for nine profiles across an eleven-player sample squad, reconciled usable sample totals, completed the pool scan and checked the 35- and 28-match schedules without page errors. A profile with no usable evidence still uses the existing fallback.

Publish both updated HTML entry points to update the hosted builder. No additional runtime assets or backend changes are required by this integration.
