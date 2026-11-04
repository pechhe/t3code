# Failure triage pilot (T3-356)

Advisory experiment: can the bounded decision engines (Jev, Luna) look at the evidence of one failed engineering check and say where to look first? It consumes the shared `DecisionService` from T3-350 and changes no retry, quarantine, dismissal, gate or default. Nothing here triggers an action from a prediction.

## Outcome: revise, do not adopt

Jev was the most useful system on this small pilot and Luna was not. Jev read the supplied evidence best and never dismissed a case whose cause was a regression or never found. But the corpus has only 6 authentic incidents, and none of them supported a specific label from the log alone. Luna abstained often and, on the one case that matters most, dismissed a real regression as an environment failure. No system should be allowed to retry, dismiss or quarantine anything on this evidence. The useful next step is a larger set of authentic failures with causes settled by a person, labelled before any model runs.

## Questions and labels

One `choice` question per case (`rule.ts`, rule `failure-triage-pilot` v1) over five labels. The prediction is the label with the highest returned probability; an exact tie falls to `unknown`. The returned `choice` is recorded but not trusted (it matched the highest probability in every call of the retained runs, and in all but one Jev call of the superseded first run).

- **regression**: the evidence points to the change under test or the commits since the last good run.
- **fixture**: the evidence points to the test, its data, expectations or harness being wrong or stale.
- **environment**: the evidence points to the machine, network, registry, disk, memory, clock or other infrastructure.
- **known-flake**: the failure matches a documented intermittent failure in the supplied registry and the history is consistent with intermittency.
- **unknown**: the evidence does not support one of the others. A symptom is not a proven cause, and `unknown` is a correct answer for many single logs.

The models see only the evidence object and these definitions. They do not see ids, families, strata, the author's reading or the later-resolved cause.

## Two references

The advisor review of this design found one reference cannot serve two questions, so every case has both:

- **Supported label**: what the supplied evidence alone supports. Two blind labelers that are not evaluated engines (gpt-6-astra via Codex, deepseek-v4.1-flash via Pi) labelled the held-out evidence under anonymised ids and the same definitions, before any held-out model call. They agree on 22 of 28. The author's reading only breaks a split between them; a three-way split would be `uncertain` (none occurred). Primary accuracy is scored against this label. Raw labels: `results/heldout-labels.json`.
- **Resolved cause**: what later work showed the cause to be, with basis and confidence (`resolvedCause` in the corpus). It is retrospective, never in a request, and used for the safety measures and a separate recovery rate. For synthetic cases it is the author's construction.

Cases from one incident share a family and a split. Run history, registry entries and changed files in the evidence are facts that existed when the failure was observed.

## Corpus

| Stratum       | Tune | Held-out | Source                                                                                                                                                                                    |
| ------------- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| authentic     | 3    | 6        | This repository's retained nightly-audit failure records (`slipjay audit status`), one fixed extraction rule, redacted by the audit itself (`[CHECKOUT]`).                                |
| reconstructed | 0    | 3        | Symptoms rewritten from the fix commit's description of what failed. The explanation is withheld, but the wording, history facts and file counts are approximations, not retained logs.   |
| synthetic     | 5    | 19       | Written for this pilot, including hard negatives: a timeout that is a deadlock regression, an OOM kill caused by the change, a registry flake with a different error, and truncated logs. |

Authentic families: web unit contention (tune: 29-31 Oct), an upstream merge regression mixed with a Playwright upgrade break (held-out: 26-27 Oct), an unexplained MCP sign-in failure (28 Oct), a date-dependent fixture that failed every commit once a 92-day cache window passed (held-out: 2-3 Nov, fixed by 8c12bfaf41, though a person recorded one of those audits as a flake), and an unexplained browser mock rejection (4 Nov). Eight failures from one 10-night window are not eight independent observations: held-out holds 4 authentic families.

**Extraction rule (authentic):** the check, exit status and failure kind; up to 12 failing test names; the audit's first error (cut at 700 characters); the last 1,800 characters of retained output cut at a line; the files changed since the previous audit (count and first 15); the failing history of the previous three audits. It was applied mechanically to every failed audit in the retained window; fields were not chosen per case, though the author had already read the fix commits. Note that every audit leads with the same noisy first error, a git refusal printed by a passing test; the rule keeps it on purpose.

**Baseline** (`baseline.ts`, `exit-signature-v1`): bare exit gives unknown; an environment signature (ECONNRESET, ENOSPC, registry 5xx, `Killed`, exit 137 and similar) gives environment; a failing test named in the flake registry gives known-flake; a TypeScript error gives regression; a failing file whose name matches a changed file gives regression; a fixture or snapshot signature gives fixture; otherwise unknown. It was written once and fixed before any held-out model call. It was not tuned on the tune set, but the held-out cases were authored before it was written, so its author knew the case designs. **Always-unknown** is a second reference: it never dismisses, and it shows how much of any score is plain abstention.

## Results (held-out, n = 28; supported labels all certain)

| System         | Accuracy vs supported (95% Wilson) | Resolved cause recovered | Dismissed a regression (strict, of 9) | Dismissed a regression or unresolved cause (of 16) | Also diverted to fixture (of 16) | False known-flake (of 26) | Explicit unknown (of 28) | Over-abstention (of 16) | Appropriate abstention (of 12) |
| -------------- | ---------------------------------- | ------------------------ | ------------------------------------- | -------------------------------------------------- | -------------------------------- | ------------------------- | ------------------------ | ----------------------- | ------------------------------ |
| Jev            | 23/28 (0.64-0.92)                  | 18/28                    | 0                                     | 0                                                  | 1                                | 0                         | 11                       | 1                       | 10                             |
| Luna           | 17/28 (0.42-0.76)                  | 13/28                    | 1                                     | 1                                                  | 2                                | 0                         | 17                       | 7                       | 10                             |
| Baseline       | 19/28 (0.49-0.82)                  | 14/28                    | 3                                     | 3                                                  | 3                                | 1                         | 16                       | 4                       | 12                             |
| Always-unknown | 12/28 (0.27-0.61)                  | 7/28                     | 0                                     | 0                                                  | 0                                | 0                         | 28                       | 16                      | 12                             |

- **Dangerous cases.** Baseline dismissed `h-syn-regression-oom` (the `Killed` signature), `h-syn-regression-looking-environment` (ECONNRESET) and `h-syn-flake-registered-different-error` (a registered test, a different error). Luna dismissed the first of those as environment (probability 0.75, Jev gave regression 0.65). Jev's one diversion was the unresolved 4 Nov audit called a fixture (0.57), which Luna also did (0.62). Zero dangerous dismissals in 16 risk cases has a 95% Wilson upper bound of about 0.19, so even Jev's clean record does not show the rate is low.
- **Paired against the baseline on supported labels (28 cases).** Jev was right where the baseline was wrong on 7 cases and wrong where it was right on 3 (the 4 Nov audit, the Electron race, the deadlock); Luna was right where the baseline was wrong on 1 and wrong where it was right on 3. Jev beat Luna on 6 cases and lost on none.
- **By stratum** (accuracy / dismissals of the risk cases): authentic Jev 5/6 and Luna 5/6, with 0 of 4 dismissed by either; baseline 6/6 and always-unknown 6/6 because every authentic case is supported `unknown` and the baseline falls through to it. Reconstructed Jev 1/3, Luna 1/3, baseline 2/3. Synthetic Jev 17/19, Luna 11/19, baseline 11/19, always-unknown 4/19. The separation between systems is almost entirely in the synthetic cases.
- **Label sensitivity** (`sensitivity` in `results/heldout.json`): scoring against labeler A alone gives the same numbers; against labeler B alone, Jev 21/28, Luna 15/28, baseline 13/28, always-unknown 6/28; against agreed cases only (22), Jev 19, Luna 13, baseline 13. Jev ranks first under every view. Luna against the baseline does not hold still: behind it (17 vs 19) on the primary and labeler A views, ahead (15 vs 13) under labeler B, level (13 vs 13) on agreed cases. The dependable differences are Jev's lead and the baseline's and Luna's dismissals, not an ordering of Luna and the baseline.
- **Misses.** Jev: the 4 Nov audit as fixture (supported unknown), the Electron race as environment (supported unknown), the deadlock as unknown (supported regression, regression 0.34), the moved project switcher as regression (supported fixture) and the stale migration list as regression (supported fixture, probabilities 0.47 vs 0.46, a near tie). Luna also failed the stale-label, test-order, refused-connection and flake-with-different-error cases by saying unknown or regression.
- **Repeatability.** The held-out set was run twice, the second time after the review of this change found the run identity incomplete (`run.ts` and `provenance.ts` joined it; see Reproducing). The first run is kept in `results/first-run/`. Jev changed one of 28 labels between them (the near-tie migration list: fixture 0.48, regression 0.42 first; regression 0.47, fixture 0.46 second), which moved its accuracy from 24/28 to 23/28. Luna changed none. The retained table above is the second run. Two repeats of 28 cases give no repeatability estimate, only a sign that near-tie cases are unstable.
- **Tuning set** (8 cases): all three systems 7/8 and the same miss (a deliberate label rename called a regression). Nothing was changed after it; the tune run used the frozen files.

### Cost and latency (measured, 28 calls per engine on held-out, no failures)

| Engine | Mean / p50 / max latency | Input tokens | Output tokens                | Cost (estimate) |
| ------ | ------------------------ | ------------ | ---------------------------- | --------------- |
| Jev    | 227 / 193 / 946 ms       | 34,028       | 1,588                        | about $0.00143  |
| Luna   | 298 / 308 / 572 ms       | 24,897       | not reported by the provider | about $0.00249  |

Costs are the service's endpoint input-price estimates, not invoices. Every call of the retained runs succeeded (56 held-out and 16 tune). Five runs were made in all: held-out twice (the first is in `results/first-run/`, with about the same cost), tune three times (one on an earlier revision of this harness, not retained), about $0.012 estimated in total over 160 calls. Figures above are the retained second run. A failed or unobserved attempt would keep a run's totals unknown (`unobservedAttempts`), not zero; there were none. The sequential 1.5 s gap, not the models, dominated wall time, and the calls stayed under 60 per minute. This says nothing about the cost at scale, about review time saved or about rerun cost, which the baseline's decisions would avoid.

## Limitations

- Six authentic incidents from four families. All six supported `unknown` from the log alone; the authentic stratum tests restraint, not diagnosis. Their resolved causes (two audits with a real regression inside a multi-cause failure, two with a date-dependent fixture, two never explained) rest on commit messages and one maintainer note, not on bisects.
- Reconstructed cases are approximations written from commit messages and cannot show how real logs read. Synthetic cases were written by one author, include their change descriptions and history, and are more informative than real logs usually are; the 17/19 and 11/19 synthetic scores overstate real-world accuracy.
- The supported label comes from two models, not people. They agree on 22 of 28; the author's reading broke the other 6. Labels in the synthetic set that contradict the author's construction (the e2e timeout read as fixture, the registry case with a different error read as regression) are kept as the labelers read them.
- One call per case and engine in each run, and only two runs: no repeatability estimate. Probabilities are uncalibrated (Luna's sit close to 0 or 1).
- 28 scored cases; the intervals overlap. No significance claim is made. The risk pool is 16 cases, and only 4 of them are authentic.
- The `known-flake` label cannot be tested honestly on real logs here: no authentic case carried a flake registry. Both flake cases are synthetic, and registry membership was part of the evidence.
- Evidence includes the change description and history, which a real triage input may lack.
- This evaluates one decision (first look). It says nothing about acting on the label, and it should not.

## Reproducing

Run from `apps/server` with the two provider keys already in the environment (`TYPESAFE_API_KEY` for Jev, `OPENAI_API_KEY` for Luna); never pass keys as arguments.

```sh
node src/decisionEvaluations/failureTriage/run.ts --split heldout --out /tmp/heldout.json --gap-ms 1500
```

`--split tune` runs the tuning cases. `--rescore --out <results.json>` re-scores retained records without calling any provider and keeps the original run identity. Each result file records the run identity (`run`: the checkout's `HEAD`, whether the working copy was dirty, and the sha256 of every file that decides what is asked or how it is called: the corpus, rule, baseline, harness, entry point and this manifest, the foundation service and the contract) and, separately, the scorer identity (`scorer`). The source revision is measured, not supplied: the retained held-out run was made at parent `c44a2d5d39` with a dirty working copy, so the per-file digests are the exact identity, and `failureTriage.test.ts` fails if any of those files changes without a new run. Results retained here: `results/heldout.json` (second run, 22:45 UTC, 4 Nov 2026) and `results/tune.json`, whose identities the tests check against the current files; `results/first-run/` (the superseded first runs, 22:25 and 22:27 UTC), whose records the tests re-score but whose identity predates `run.ts` joining the manifest; and the blind labels.
