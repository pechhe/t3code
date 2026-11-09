# Context and skill ranking pilot (T3-357)

Advisory experiment: can the bounded decision engines (Jev, Luna) rank a task's candidate skills, files and prior findings so that the needed ones are kept at a lower context volume than a lexical baseline? It consumes the shared `DecisionService` from T3-350 and changes no skill visibility, prompt, routing or default. Nothing here excludes any context automatically.

## Outcome: revise, do not adopt for exclusion

- **Retention, same k.** With the top 5 of 16 candidates kept, Jev retained 54 of 58 needed items and Luna 56, against 48 for the frozen lexical baseline (BM25). Whole cases that lost a needed item: Jev 4 of 30, Luna 2, lexical 9. Both engines were ahead of lexical in every labeler view. Intervals overlap (Wilson 95%: Jev 0.84-0.97, Luna 0.88-0.99, lexical 0.71-0.90); no significance claim is made. An earlier complete run of the same corpus (`results/first-run/`) gave Jev 55, Luna 56 and 3 and 2 whole cases.
- **Volume is not lower at the same k.** The engines keep more estimated tokens than lexical (Jev 51k, Luna 58k, lexical 37k per case, against 103k for all 16) because the items they rightly pick include the largest skills. They save 50% and 44% against keeping everything; lexical saves 64% while missing more.
- **Volume at a fixed budget does not separate them.** With a 6,000 estimated-token budget all three keep the same volume (about 7.5k with the fixed context) and the same recall within two items (42, 42, 40 of 58): many needed items are bigger than the budget.
- **The only rule that cuts volume sharply loses needed context.** Keeping candidates with probability >= 0.5 saves 75% (Jev) and 78% (Luna) of the volume but drops needed items in 10 and 12 of 30 cases (recall 47 and 45 of 58). That is not safe for any automatic exclusion.
- **Downstream effect is barely measured.** Six held-out questions, three arms, one answer each (the Jev arm used the selections of the final held-out run; governing context is given whole to every arm): all candidates met 17 of 19 rubric lines, Jev top 5 met 18 and lexical top 5 met 16, with about 55% fewer context characters than the full set. The arms are within one line of each other, which this size cannot separate, and a first version that left the governing context out of every arm (`results/first-run/downstream.json`: 17, 15 and 14) was withdrawn after review. Recommendation is limited accordingly: **use ranking, if at all, to order or highlight context, never to remove it, and keep governing instructions and requested skills outside it** (they are, unconditionally, in this harness).

Token savings alone are not task quality: the held-out recall and the six-case downstream check are the only quality evidence here.

## Design

- **Case** (`corpusTune.ts`, `corpusHeldout.ts`): a task, governing context (`AGENTS.md`) and any explicitly requested skills (never ranked, always included, enforced by tests), and 16 candidates drawn from a pool of 201 real items (`pool.json`): 22 skills (real front matter), 147 repository files (docs by heading, source by exports) and 32 prior findings (`findings.ts`, restated from retained project records). Candidates are the author's expected items, tempting decoys with similar names or topics, and seeded filler.
- **Ranker input** (`rule.ts`): the task, the names of what is already included, and each candidate's kind, title and description in a fixed shuffled order with opaque refs. One predicate question per candidate; the returned probability is the score. Rankers see no labels, ids, families, strata or changed files.
- **Reference labels** (`results/labels-A.json`, `labels-B.json`): two blind labelers, a different model each (`advisor` role gpt-6-astra; `scout` role deepseek-v4.1-flash), labelled every candidate needed, helpful, unneeded or unknown before any live call, reading the real files and skills. They never saw a ranking, the baseline or the code; the author breaks no ties. Needed or unneeded needs both to agree; needed/helpful splits are `helpful`; needed or helpful against unneeded, or any unknown, is `uncertain` and is reported, not resolved. 558 of 640 judgements matched; 75 candidates are agreed needed, 81 helpful, 440 unneeded, 44 uncertain. The author's expectation matched the agreed labels on 68 of 110 expected items; the rest were judged helpful or uncertain.
- **Systems**: Jev, Luna, lexical `bm25-pool-idf-v1` (title and description against the task, pool-wide idf), a seeded random floor, keep-all and keep-none. Declared before the held-out run and not changed after: top-k = 5 (primary, scale-free), probability threshold 0.5 (engines only), budget 6,000 estimated tokens (rank order, skipping what does not fit).
- **Cases**: 8 tune (3 authentic, 1 reconstructed, 4 synthetic) and 32 held-out (12 authentic restated from real commits at this checkout, 6 reconstructed from the Arc's own records, 14 synthetic with hard negatives), families disjoint. For authentic cases the files a real commit changed are recorded (`changedFiles`) as evidence independent of every labeler. Two held-out cases have no agreed-needed item (a comment typo and a stray server): they test over-inclusion.

## Results (held-out, 30 scored cases with at least one agreed-needed item)

| System  | Recall of needed, top 5 | Cases missing a needed item | Mean AP | Needed / helpful / unneeded / uncertain kept | Mean est. tokens kept |
| ------- | ----------------------- | --------------------------- | ------- | -------------------------------------------- | --------------------- |
| Jev     | 54/58 (0.93)            | 4                           | 0.84    | 54 / 39 / 49 / 18 (of 160)                   | 51,320                |
| Luna    | 56/58 (0.97)            | 2                           | 0.82    | 56 / 39 / 53 / 12 (of 160)                   | 57,802                |
| Lexical | 48/58 (0.83)            | 9                           | 0.70    | 48 / 29 / 65 / 18 (of 160)                   | 36,785                |
| Random  | 21/58 (0.36)            | 23                          | 0.26    | 21 / 23 / 108 / 8 (of 160)                   | 35,546                |

All 16 candidates kept: 103,222 estimated tokens. Governing context only: 1,799.

- **Pairing against lexical** (cases where every needed item was kept by one and not the other): Jev better in 7, worse in 2 (`h-cost-aggregation`, `h-unattended-spec`); Luna better in 8, worse in 1 (`h-cost-aggregation`).
- **By stratum, cases missing a needed item**: authentic (12 cases) Jev 0, Luna 1, lexical 4; reconstructed (6) Jev 1, Luna 1, lexical 2; synthetic (14) Jev 3, Luna 0, lexical 3. Jev's misses were `h-cost-aggregation` (reconstructed) and the synthetic `h-settings-animation`, `h-dev-pairing`, `h-unattended-spec`; Luna's were `h-readonly-enforcing-provider` and `h-cost-aggregation`.
- **Label sensitivity** (recall of needed, Jev / Luna / lexical): agreed 54/58, 56/58, 48/58; relaxed (a needed/helpful split counts as needed) 72/87, 75/87, 57/87; labeler A alone 69/84, 68/84, 57/84; labeler B alone 61/69, 66/69, 53/69. Jev and Luna lead lexical under every view; Jev and Luna trade places.
- **Tuning set** (8 cases, 17 needed items): lexical 12, Jev 17, Luna 16. Two retained runs (final and `first-run/`) gave the same, as did the earlier final; an earlier tune pass on the same inputs gave Jev 16, so a single answer is not stable to one item.
- **Downstream check** (`results/downstream.json`): cost-summary, recommendation, flaky-test, rate-limit, single-label and dev-pairing questions with rubrics fixed before the run. Each answer came from a fresh `scout`-role worker told to use only the supplied text; a separate `advisor`-role grader scored answers in a shuffled, unlabelled order. Every prompt carries `AGENTS.md` whole, then the arm's candidates cut at 2,000 characters each. All candidates 17/19 (about 31,000 characters), Jev top 5 18/19 (about 13,900), lexical top 5 16/19 (about 13,400); the full set and both ranked arms each missed the "read the change" or "follow the development guide" line in at least one case. The earlier withdrawn version is kept in `results/first-run/downstream.json`.

### Cost, latency and tokens (measured, final held-out run: 32 calls per engine, none failed)

| Engine | Mean / p50 / max latency | Reported input tokens | Output tokens | Cost (estimate) |
| ------ | ------------------------ | --------------------- | ------------- | --------------- |
| Jev    | 179 / 170 / 308 ms       | 98,062                | 9,344         | about $0.0041   |
| Luna   | 372 / 300 / 667 ms       | 145,831               | not reported  | about $0.0146   |

No call in the final run failed. The earlier final run (5 Nov) had one Luna call fail with code `unavailable` (`h-dev-pairing`, not retried), which counted as dropping its needed items; the run above replaced it. In the first run (`results/first-run/heldout.json`) Jev averaged 215 ms and about $0.0041, Luna 377 ms and about $0.0146 with no failure. Costs are the service's endpoint input-price estimates, not invoices. Estimated against reported request tokens (bytes/4 over the request): Jev 0.93 (0.91-0.97), Luna 0.63 (0.62-0.65), so Luna's tokenizer counts about 1.6 times as many tokens for this JSON. **Included volume is an estimate** (candidate body bytes / 4); only the ranking requests have measured counts, and they cover descriptions, not bodies. Live calls in all: 256 ranking calls (a first tune pass not retained, plus tune and held-out three times), about $0.06 estimated in total; one failed call in the superseded run, none refused or blocked.

## Limitations

- Labels come from two models, not people. They split on 38 needed/helpful judgements and 44 candidates are uncertain; recall is scored against agreed-needed only. They read the real files while rankers saw one-line descriptions, which is the intended asymmetry.
- Tasks for authentic cases are restated from commits after the fact. Decoys were chosen by the author and 14 of 32 held-out cases are synthetic; Jev's misses are mostly there (three of four), and lexical's authentic misses suggest the real cases are harder for lexical, not easier. One author wrote every task and the pool is this repository, its fork records and one operator's skills.
- A real library is far larger than 16 candidates. One call carries at most 32 questions, so ranking 200 items needs batching that is untested here; nothing says how the scores of separate batches compare.
- Ranking keeps its place only in the ordering sense: the threshold rule drops needed items in more than a third of cases.
- One call per case and engine per run, four tune passes (one not retained) and three held-out passes (two retained): the held-out passes differ by one needed item per engine, and nothing more is known about repeatability. Probabilities are uncalibrated and differ between engines.
- Downstream: six questions, one answer each, a low-effort answerer with read access to the repository though told not to use it, an LLM grader, bodies cut at 2,000 characters, and an answerer given a ranked set that sometimes also holds irrelevant text. It cannot separate the arms.
- 30 scored cases; no significance claim. The lexical baseline is one simple BM25; a stronger retriever (embeddings) was not tried.

## Reproducing

Run from `apps/server` with the two provider keys already in the environment (`TYPESAFE_API_KEY` for Jev, `OPENAI_API_KEY` for Luna); never pass keys as arguments. Respect the shared 60-per-minute limit (`--gap-ms 1500`).

```sh
node src/decisionEvaluations/contextRanking/run.ts --split heldout --out /tmp/heldout.json --gap-ms 1500
```

`--split tune` runs the tuning cases. `results/first-run/` holds the earlier complete pass, made before a lint-only edit of the harness, corpus comments and runtime fields; it is reproducible from its records but its run identity no longer matches the code. The retained runs (13:03 and 13:04 UTC, 9 Nov 2026) were made at this code, so their recorded identities match today's files and a test fails if any of those files changes without a new run. The downstream check read candidate bodies at commit `97202bdf4f`, because the pool holds files deleted since. `--rescore --out <results.json>` re-scores retained records without calling a provider; it refuses if any file that decides what was asked has changed. Each result records the run identity (the checkout `HEAD`, whether the working copy was dirty, the runtime, and the sha256 of every file that decides what is asked or how it is called: the entry point, provenance helper, rule, baseline, harness, corpus, pool, the foundation code and the lockfile), the scorer digest (scoring, labels and the shared scorer), and the corpus digest. A live run refuses to start unless both label files hold a label for every candidate and were captured against this exact corpus.

`buildPool.ts` rebuilds `pool.json` from the current skills and docs (it reads `~/.agents/skills`, so a later run may differ); `labelPackets.ts` writes the packets the labelers read; `downstream.ts prepare` and `score` build the downstream prompts and score graded answers. The labelers' replies and the downstream answers were transcribed by hand into the retained JSON, and the labeler compact form is not retained.
