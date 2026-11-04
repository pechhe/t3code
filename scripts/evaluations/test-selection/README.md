# Decision-guided test selection: evaluation (T3-354)

Evaluation-only harness. It changes no gate, selector or mandatory check. It consumes `DecisionService`
(T3-350, `docs/operations/decisions.md`) in-process with the landed adapters and bounds.

**Outcome: revise, do not adopt.** The engines rank failing tests above passing ones. At the gate's real
60 s budget there was nothing to gain on these cases. Under stress budgets Jev improved as many regressions as the oracle (4 at 20 s, 5 at 10 s) but caught fewer files (55 vs 57, 43 vs 48), on only 3 source files, so this is a signal and not a significance claim.

## What was measured

- **Mechanism.** `budgetLandingTests` from `scripts/test-landing.ts`: ranks 0/1 mandatory, ranks 2-4 fill a 60 s
  estimated budget. Candidates are the gate's real Vitest related-test listing. Arms reorder **only ranks 2-4**.
  Mandatory tests are never touched or deferred.
- **Labels (independent of any engine).** A seeded, syntax-checked single-line mutation is planted in a real source
  file and **every candidate test is executed**; failures that also fail on the pristine source are excluded as
  `uncertain`. 17 held-out regressions in 10 source modules (13 on small fan-out, 4 on hub files) and 4 tuning regressions.
  Hub fan-out (166 and 178 candidates) was too heavy to execute under the host load, so hub cases keep every mandatory
  test plus a seeded sample of 60 others (`subsampledFrom` in each case). Mutation kill rate was 21 of 47 (45%);
  the 26 survivors are retained in `corpus/attempts/`. A failure counts only against an explicit passing pristine run
  (`corpus/controls.json`); a missing or failing control makes the file `uncertain`. Tests with no result are `unreported`;
  only tests that ran green under the mutation (`verifiedPassing`) count as passing anywhere.
- **Split.** Whole source files by hash (30% of non-hub files tune; hub files are held-out only). Rule wording v1
  vs v2 was compared on tuning only (identical, AUC 1.0 on 24 pairs); v1 was frozen before held-out scoring.
- **Historical.** 10 real landed source diffs (tests removed from the diff) scored by both engines. They have no failure labels,
  so they show behaviour only (`results/summary-historical.json`).
- **Engines.** `jev-1.14.0` and `gpt-6-luna` through the shared service; one predicate question per discretionary
  test, 32 per call, evidence = diff hunk + test path, titles, imports and recorded seconds.

## Held-out results (17 regressions, 65 failing test files)

Recall is over failing test files that the arm's selection includes. "Verified-green run" counts discretionary tests run that ran green under the mutation; "Unknown-outcome run" counts those whose outcome is unknown (uncertain, or not reported because the run did not cover them), which no metric treats as passing.

| Budget | Arm | Failing caught | Missed | Regressions detected | All failures caught | Verified-green run | Unknown-outcome run |
|---|---|---|---|---|---|---|---|
| 60s | baseline | 63 | 2 | 17/17 | 15/17 | 458 | 39 |
| 60s | cheapest-first | 63 | 2 | 17/17 | 15/17 | 458 | 39 |
| 60s | random(mean of 5 seeds) | 63 | 2 | 17/17 | 15/17 | 458 | 37 |
| 60s | jev-v1 | 63 | 2 | 17/17 | 15/17 | 459 | 35 |
| 60s | luna-v1 | 63 | 2 | 17/17 | 15/17 | 458 | 39 |
| 60s | oracle | 63 | 2 | 17/17 | 15/17 | 458 | 39 |
| 20s | baseline | 51 | 14 | 17/17 | 12/17 | 335 | 11 |
| 20s | cheapest-first | 46 | 19 | 17/17 | 13/17 | 318 | 13 |
| 20s | random(mean of 5 seeds) | 51 | 14 | 17/17 | 12/17 | 296 | 9 |
| 20s | jev-v1 | 55 | 10 | 17/17 | 13/17 | 291 | 7 |
| 20s | luna-v1 | 52 | 13 | 17/17 | 13/17 | 330 | 10 |
| 20s | oracle | 57 | 8 | 17/17 | 13/17 | 332 | 10 |
| 10s | baseline | 36 | 29 | 17/17 | 11/17 | 151 | 0 |
| 10s | cheapest-first | 34 | 31 | 16/17 | 10/17 | 161 | 0 |
| 10s | random(mean of 5 seeds) | 38 | 27 | 17/17 | 11/17 | 139 | 0 |
| 10s | jev-v1 | 43 | 22 | 17/17 | 13/17 | 134 | 0 |
| 10s | luna-v1 | 42 | 23 | 17/17 | 13/17 | 140 | 0 |
| 10s | oracle | 48 | 17 | 17/17 | 13/17 | 136 | 0 |

Paired against the gate's order (regressions where the arm caught more / fewer failing files):

| Budget | Arm | Better | Worse | Same | Source files behind the gains |
|---|---|---|---|---|---|
| 20s | cheapest-first | 1 | 2 | 14 | 1 |
| 20s | oracle | 4 | 0 | 13 | 3 |
| 20s | jev-v1 | 4 | 0 | 13 | 3 |
| 20s | luna-v1 | 1 | 0 | 16 | 1 |
| 10s | cheapest-first | 0 | 2 | 15 | 0 |
| 10s | oracle | 5 | 0 | 12 | 3 |
| 10s | jev-v1 | 5 | 0 | 12 | 3 |
| 10s | luna-v1 | 5 | 0 | 12 | 3 |

Ranking quality over 1105 failing / verified-green pairs: Jev AUC 0.82, Luna AUC 0.65
(0 abstentions). Candidates whose outcome is unknown (uncertain or never reported) are in neither side of any pair and are counted separately.

Reading it:

- **60 s: no headroom.** Gate = oracle = every arm; 2 failing files are unreachable for every arm, oracle included.
  The real budget rarely defers anything for small changes, and direct importers (where most failures live) are mandatory already.
- **Stress budgets (20 s, 10 s)** only simulate a binding budget. Jev improved 4 and 5 regressions and worsened none; Luna 1 and 5.
  The duration-only control did worse than the gate, and 5 random orders matched the gate, so the gain is semantic and not a cost artefact.
- Everything rests on 3 source files with gains; no significance is claimed.

## Cost, latency, rate limits (`results/costs.json`)

- Jev: 289 ms mean service latency per 32-question call, about 6.9 k input tokens per call, est. $0.032 for the whole pilot.
- Luna: 478 ms, about 9.1 k, est. $0.099. Output is free at the listed prices; prices are the doc's estimates.
- Selecting a hub change needs 6 calls (about 190 candidates), so 2-4 s of added latency per candidate set, small against a 60 s budget but not free for the common 1-5 candidate change.
- **Rate limit.** The first historical run (`results/historical-v1.attempt1-ratelimited.json`) was unpaced and 16 of 76 calls were rejected `rate-limited` by the shared 60/min window. Treated as abstentions, never as positives. The paced rerun (45/min) had 0 failures. Any gate use would share that 60/min with every agent.
- Not measured: abstention under provider refusal (none occurred; 0 abstentions), cache effects (Luna caching is disabled by the service).

## Estimated vs measured runtime

`gateEstimateWallSeconds` uses `tests/durations.json` (worker-seconds from audit reports plus startup). The measured
columns come from the labelling runs on a host at load 45-90, so they overstate a quiet runner; the point is that
estimates and measurements are different quantities: for the 21 labelled cases measured worker-seconds ranged from 0.1x to 5x the recorded ones, and measured wall time was not proportional to either.
Per-arm wall time was **not** measured: arms differ only in which files they choose, so arm runtime is the gate's estimate for the chosen set.
Deferred tests are deferred to the nightly audit, never eliminated.

## Limitations

- Single-line mutants are not realistic integration regressions; small fan-out changes have almost nothing to reorder.
- 4 hub cases are subsampled (61 of 166/178), so the real 60 s budget is not exercised on hubs at all.
- Mutations come from few modules; clustered by source file the sample is about 10 clusters (3 with gains).
- Historical diffs are unlabelled; the candidate list uses this checkout, not the tree at the commit.
- Host load inflated every measured time. A stale `vfile` install (SJ-194) invalidated a first labelling attempt; its per-case files were discarded, so only a summary survives in `results/failed-attempts.md` along with every other failed or interrupted attempt.

## Recommendation

Revise before any adoption: (1) a larger run of un-subsampled hub regressions on a quiet runner; (2) at most
advisory use, reordering ranks 2-4 only when the budget binds, falling back to the gate's order on any error,
refusal or rate limit; (3) Jev over Luna in this pilot (higher ranking quality, lower latency and cost).
Mandatory checks and the nightly audit stay as they are.

## Reproduce

```
node scripts/evaluations/test-selection/build-candidates.ts <source file>   # cache the gate's related-test listing
node scripts/evaluations/test-selection/seed-cases.ts <source file> <count> <seed>   # label seeded regressions (T3_SAMPLE=60 subsamples hubs)
node scripts/evaluations/test-selection/historical.ts <commit>...
node scripts/evaluations/test-selection/split.ts
node scripts/evaluations/test-selection/run.ts <tuning|heldout|historical> v1 <result file> [case regexp]
node scripts/evaluations/test-selection/report.ts <split>
```

`run.ts` reads the two authorised keys from `bws` into process memory only, pacing at 45 calls a minute.
Focused tests: `pnpm exec vp test run --config ../vite.config.ts --dir evaluations` from `scripts/`.
Identities: foundation `a27df331`, engines `jev-1.14.0` / `gpt-6-luna`, rule `test-relevance` v1 (v2 in `prompt.ts`), seeds in each case.
