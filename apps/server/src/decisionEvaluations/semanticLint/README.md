# Semantic lint pilot (T3-355)

Advisory experiment: can the bounded decision engines (Jev, Luna) screen five semantic code-review questions that deterministic lints cannot see? It consumes the shared `DecisionService` from T3-350 and changes no production lint, default or UI.

## Outcome: revise, do not adopt

On this small synthetic pilot both models matched or beat the deterministic baseline, but the corpus is too easy and too regular to support a claim that they would beat it on real diffs. The next step is a second pilot on sanitized real repository diffs with harder negatives, labelled before any model runs. Nothing here justifies a lint rule, a gate or automatic fixes.

## Protocol

- **Questions:** one predicate per case, defined per category in `rule.ts` (rule `semantic-lint-pilot` v1). A case is flagged when the returned probability is at least 0.5, fixed before any held-out run. Probability is not treated as confidence in correctness.
- **Corpus:** 10 tuning cases and 34 held-out cases, synthetic and secret-free, five categories each with clear positives and tricky negatives (`corpusTune.ts`, `corpusHeldout.ts`). The held-out set was not run until the rule and labels were frozen. Tuning ran twice and changed nothing: the first run used an earlier revision of this harness and was not retained, the second used the frozen revision (`results/tune.json`). The blind labels were collected before any held-out model call.
- **Reference labels:** two blind labelers (gpt-6-astra via Codex, deepseek-v4.1-flash via Pi, neither of which is an evaluated engine) labelled the held-out cases from the same category definitions the engines receive. They agree on 31 of 34. The author's by-construction label only breaks a split between them; a three-way split is `uncertain`. Result: 15 defect, 17 ok, 2 uncertain (uncertain cases are excluded from precision and recall). Raw labels: `results/heldout-labels.json`. Both labelers overrode the author's defect label on h-smell-3 (to ok) and resolved two of the author's four uncertain labels (h-name-7 to defect, h-smell-7 to ok).
- **Baseline:** simple pre-registered heuristics in `baseline.ts` (comment/number drift, read-only name with write or network token, short literal error message, removed or weakened `expect`, many awaits, methods or parameters). They are not the production oxlint rules; the existing `no-low-value-comments` rule targets obvious comments, a different axis from stale ones.
- **Calls:** one admitted call per case and engine, 1.5 s apart, no retry, no alternate provider. Failures, refusals and unknowns count as not flagged and are reported separately (there were none).
- **Not asked of the models:** dead code, duplicates and anything static analysis proves.

## Held-out results (n = 34 cases, 32 with a certain reference)

| System   | TP  | FP  | FN  | TN  | Precision (95% Wilson) | Recall (95% Wilson) | False-alarm rate | AUC  | Flagged / true defect |
| -------- | --- | --- | --- | --- | ---------------------- | ------------------- | ---------------- | ---- | --------------------- |
| Baseline | 13  | 3   | 2   | 14  | 0.81 (0.57-0.93)       | 0.87 (0.62-0.96)    | 0.18 (0.06-0.41) | 0.85 | 1.23                  |
| Jev      | 15  | 1   | 0   | 16  | 0.94 (0.72-0.99)       | 1.00 (0.80-1.00)    | 0.06 (0.01-0.27) | 1.00 | 1.13                  |
| Luna     | 15  | 1   | 0   | 16  | 0.94 (0.72-0.99)       | 1.00 (0.80-1.00)    | 0.06 (0.01-0.27) | 0.99 | 1.13                  |

- **Misses:** baseline missed h-comment-2 (documented throw became `undefined`) and h-name-7 (validator mutates its input); neither model missed a defect.
- **False alarms:** baseline flagged h-error-5, h-assert-6 and h-smell-5; both models flagged only h-smell-3, which the author labelled defect and both blind labelers labelled ok. That case is a genuine labelling dispute, so the models' one false alarm may be a true positive.
- **Uncertain cases:** both models flagged h-assert-7 (probability 0.61 Jev, 1.0 Luna); neither flagged h-comment-7.
- **Label sensitivity** (`sensitivity` in `results/heldout.json`): with either single labeler or agreement-only labels the models keep 0 or 1 misses and 1 or 2 false alarms; the ordering versus the baseline does not change.
- **Escalated-review burden:** the models flag 17 of 34 cases (half the corpus, by construction: prevalence is artificial). A reviewer reading flags reads about 1.13 items per real defect, against 1.23 for the baseline.
- **Cost and latency (measured, held-out run, 34 calls per engine):** Jev mean 187 ms, p50 164 ms, max 563 ms, 14,703 input tokens, about $0.00062; Luna mean 259 ms, p50 225 ms, max 736 ms, 10,502 input tokens, about $0.00105. Costs are provider-endpoint input-price estimates from the service, not invoices; output is free; the sequential 1.5 s gap dominated wall time. Both tuning runs added 20 calls each; every call stayed within the 60 per minute admission limit. Failed or unobserved attempts would leave run totals unknown (`unobservedAttempts`, with known subtotals separate); there were none. These say nothing about cost at scale or against human review time.
- **Tuning set:** Jev 5/5 TP, 0 FP; Luna missed t-comment-1 (stale "10 seconds" comment beside a timeout changed to 45 s), as did the baseline.

## Limitations

- Synthetic cases written by one author, clustered around authored patterns, with several negatives that restate exceptions named in the prompt. This measures recognition of those patterns, not generalisation to real code.
- 32 scored cases; every interval overlaps. No significance claim is made.
- Reference labels come from two models, not humans. They can share errors.
- One call per case and engine: no repeatability estimate. Probabilities are uncalibrated; Luna's were close to 0 or 1 while Jev's were more graded, which this pilot cannot interpret.
- Threshold 0.5 was fixed in advance and not tuned per engine. Failures would have counted as misses on defects and as correct on clean cases; there were none.
- Prevalence is artificial (about half the cases are defects), so precision and the flagged share do not transfer to real review.
- Categories use only evidence shown. Questions that need repository context (call sites, other files) were deliberately limited to two boundary cases.

## Reproducing

Run from `apps/server` with the two provider keys already in the environment (`TYPESAFE_API_KEY` for Jev, `OPENAI_API_KEY` for Luna); never pass keys as arguments.

```sh
node src/decisionEvaluations/semanticLint/run.ts --split heldout \
  --out /tmp/heldout.json --source-revision <commit> --gap-ms 1500
```

`--split tune` runs the tuning cases (no label-sensitivity views, which cover held-out cases only). `--rescore --out <results.json>` re-scores a retained run from its recorded calls without calling any provider. Output holds source revision, rule, corpus digest, per-call model, adapter version and request digest, outcomes, usage and cost, the scored summary and label sensitivity. Results retained here: `results/heldout.json` (run 2026-11-04 21:11 UTC, source `fc12f2a6586e`) and `results/tune.json`. The focused tests are `semanticLint.test.ts`.
