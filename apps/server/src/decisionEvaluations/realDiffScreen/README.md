# Real-diff screen pilot (T3-573)

Advisory experiment: given only the diff of a real, already-published commit, does a cheap decision engine flag the defects that people later had to fix? It is the second semantic-lint pilot ([T3-355](../semanticLint/README.md) used 34 synthetic cases) and consumes the shared `DecisionService`. It changes no lint rule, gate, review requirement or default. Everything here is a shadow screen scored after the fact.

**Result in one line:** Jev flagged none of 30 attributed defects (0 of 30, 95% Wilson 0.00-0.11) and 2 of 50 judged-clean changes, and its ranking was weak (AUC 0.63). Luna was not run (no key available; see [Open](#open)). The recommendation is at the end.

## What "caught" means here

Caught means caught among defects that somebody already found and wrote down. A defect nobody fixed, or fixed without naming its cause, is not in the set, so these figures say nothing about defects no record names. The set is also small, recent (22 Sep to 10 Nov 2026) and full of one kind of defect: a change that leaves a test, fixture or consumer out of step.

## Protocol

- **Yield first** ([`yield.md`](yield.md), [`results/yield.json`](results/yield.json)), written before any held-out case. Sources: a later commit whose message names an earlier one (31 attributed after a second reading of the real diffs), a revert that names a commit (0 new: 2 of 21 state a reason and both are already counted), and a Forge review finding on a published revision (0 used). That cleared the stop threshold of 30.
- **Defect case:** a published commit that a later commit names and fixes a defect in. 30 held-out defect cases (one of the 31 was dropped, below).
- **Clean case:** a commit sampled by a fixed rule ([`buildPool.ts`](buildPool.ts): integration branch of each repository, non-merge, authored 22 Sep to 10 Nov 2026, not a revert, wip, merge, release or temporary commit, not named by any mined revert or fix, 5 to 400 changed lines with code, seeded shuffle with seed `T3-573`) that **two blind labelers both labelled clean**. "No record of a defect" never makes a case clean. The labelers saw defect and sampled commits mixed and shuffled under opaque ids ([`labelPackets.ts`](labelPackets.ts)): deepseek-v4.1-flash (Pi) and claude-sonnet-5-5 (Claude), neither an evaluated engine. They could answer `unsure`. 50 held-out cases qualify. 35 sampled commits where the labelers split or said `unsure` are not scored; they are listed with the engine's answer in the results.
- **Held-out and tuning are separate.** Tuning is 3 partly attributed defects and 10 sampled commits (6 judged clean) that are not in the held-out set; they set nothing but the question wording and it was not changed.
- **Fixed before any engine call:** the labels, the sampling rule, each case's source record, whether it needs files beyond the diff and the corpus digest ([`corpus/cases.json`](corpus/cases.json), digest `469ae9177f487d0a`, recorded in the results and checked by a test; the corpus was committed as its own change before the first engine call). Nothing was changed after the first engine call except scoring code (the AUC column).
- **Question** ([`rule.ts`](rule.ts), `real-diff-screen` v1): one predicate over the commit subject and diff (generated files removed, capped at 16,000 characters). Flag at probability 0.5 or more, fixed in advance. The engine never sees the labels, the record, the baseline or the later fix.
- **Heuristic baseline** ([`baseline.ts`](baseline.ts)): T3-355's frozen five checks, run unchanged over the whole diff and OR-ed. Written for short synthetic hunks, so it is a floor. A second reference, `flag-all`, shows what reading everything costs.
- **Cases are references, not copies.** Two of the three repositories are private and this one is public, so `corpus/cases.json` records repository, commit, record, labels, whether the case needs files, and a digest of the text the engine saw. A run rebuilds each diff from the local clone and refuses a mismatch ([`diffs.ts`](diffs.ts), [`corpus.ts`](corpus.ts)).
- **Sensitive data.** Both labelers flagged possible personal or host data; 4 sampled commits were dropped. A pattern scan ([`buildScan.ts`](buildScan.ts)) of every case was read hit by hit; 2 more cases were dropped for caution (a sales-email template naming the owner and a prospect's first name, and a fixture using a real company name). Every remaining hit is a test fixture or a word containing "skip".
- **Independent reading.** Each defect was read against its real diffs by a second reader ([`yield.md`](yield.md)); each sampled case was read by two labelers; each engine flag on a judged-clean case was read by a third model (claude-opus-5-5, read-only advisor) from the same evidence.

### Reused from T3-355, and not

Reused unchanged: `scoring.ts` (Wilson intervals, AUC, cost and latency summaries) and `baseline.ts` (the five heuristics). Not reused, with the reason: its `harness.ts`, `rule.ts`, `labels.ts` and corpus types are tied to five categories of synthetic, author-labelled cases and to a by-construction reference, so this pilot has its own, with the same engine calls (`DecisionService`, one admitted call per case, no retry). T3-355's results and files are untouched.

## Held-out results (30 defects, 50 judged-clean, Jev only)

| System             | Defects caught | 95% Wilson | False alarms on clean | 95% Wilson | Items read per real defect (95% bootstrap) | AUC  |
| ------------------ | -------------- | ---------- | --------------------- | ---------- | ------------------------------------------ | ---- |
| Jev                | 0 of 30        | 0.00-0.11  | 2 of 50               | 0.01-0.13  | not defined (nothing caught)               | 0.63 |
| Heuristic baseline | 13 of 30       | 0.27-0.61  | 22 of 50              | 0.31-0.58  | 2.69 (1.83-4.75)                           | 0.50 |
| Flag everything    | 30 of 30       | 0.89-1.00  | 50 of 50              | 0.93-1.00  | 2.67 (2.05-3.64)                           | 0.50 |

- **Diff-only against needs-more-files.** The 30 defects split 7 against 23. Jev caught 0 of 7 (0.00-0.35) and 0 of 23 (0.00-0.14). The baseline caught 4 of 7 (0.25-0.84) and 9 of 23 (0.22-0.59). The diff-only group is too small to say more.
- **The baseline is at chance.** It catches 43% of defects and flags 44% of clean changes; reading what it flags costs about as much as reading everything (2.69 against 2.67 items per defect, intervals overlapping). Its apparent recall is not signal.
- **Jev's answers cluster low.** Its probability ranged from 0.11 to 0.55 over the 115 calls; mean 0.33 on defects and 0.29 on clean. The highest on any defect was 0.49, just under the fixed 0.5 line. AUC 0.63 on 80 scored cases is a weak, wide estimate.
- **Cases the labelers split on** (35 sampled commits, unscored): Jev flagged 4 (probabilities 0.50 to 0.55); the list with every answer is in `uncertain` in [`results/heldout-jev.json`](results/heldout-jev.json).
- **False alarms, before and after reading.** Jev flagged 2 judged-clean cases (`c-t3code-6a71716e`, `c-slipjay-775494fd`). The independent reader marked both false alarms, so the count is 2 of 50 before and 2 of 50 after ([`results/flag-reading.json`](results/flag-reading.json)).
- **The blind labelers missed the defects too.** Of the 30 defect commits, labeler A called 2 defects, labeler B 1, and both said clean on 4 (clean-clean); 16 were `unsure` by both. A reader of the diff, human or model, usually cannot tell either, which fits 23 of 30 needing files outside the diff.
- **Cost and latency (measured, one pass of 115 calls).** Jev mean 216 ms, p50 205 ms, max 484 ms; 407,964 input tokens; about $0.017 in the service's input-price estimate (not an invoice). Model `jev-1.14.0`, adapter `t3-decisions-v1`. One earlier invocation of the same pass printed nothing and may have made calls (under $0.02); only the pass in `results/heldout-jev.json` is retained.
- **Tuning set** ([`results/tune.json`](results/tune.json), 13 calls): every probability was 0.25 to 0.43, so nothing flagged; 0 of 3 defects, 0 of 6 clean. It was too small to tune on and the threshold stayed at 0.5.

## Limitations

- **20 of the 30 defect diffs are truncated** at 16,000 characters (5 of the 7 diff-only ones), so for those the decisive hunk may be out of view. Clean cases were truncated 5 of 50.
- Both readers of the defects and both labelers are cheap models, not people; the sampled-clean set is "no defect two models could see", so it is easier than "no defect".
- Small and recent: 30 and 50 cases, 22 Sep to 10 Nov 2026, three repositories, one author-agent mix. Every interval is wide; no significance claim is made.
- One call per case and engine, no repeat, so no repeatability estimate.
- The question asks for any later-fixable defect; a question aimed at one defect kind, or an engine that is shown the files a change touches, was not tried.
- Luna was not run.
- **Reader independence is thin.** Both readers of the defects are one model family, and the flag reader (claude-opus-5-5) shares a maker with one labeler (claude-sonnet-5-5). No person read any case; the pattern scan and its hit-by-hit read are the only other check on sensitive data.
- **No slack on the threshold.** The held-out defect count is exactly the minimum of 30: the one defect dropped for caution was the whole margin, and 31 attributed defects after verification was a margin of one. The pilot would have stopped at the yield rule had one more been unusable.
- **Reproduction needs the local clones.** Two of the three repositories are private; the corpus holds commits and digests, so another machine can rerun only with those repositories.

## Open

- **Luna was not measured.** The harness needs `OPENAI_API_KEY` in the environment; the Bitwarden store holds only per-app and day-job OpenAI keys, which were not borrowed. A key request was raised and went unanswered; the work is filed as T3-579. To finish, from `apps/server` with the key in the environment: `node src/decisionEvaluations/realDiffScreen/run.ts --split heldout --engines luna --out /tmp/heldout-luna.json --source-revision <commit>` (about $0.02), then read its flags on judged-clean cases and add its row. The Jev result above stands without it.

## Reproducing

From `apps/server`, with the Jev key in the environment (`TYPESAFE_API_KEY`; never pass it as an argument). The local clones of the three repositories under `~/Engineering` must hold the commits.

```sh
node src/decisionEvaluations/realDiffScreen/buildPool.ts        # sampled clean candidates
node src/decisionEvaluations/realDiffScreen/buildCorpus.ts      # corpus/cases.json from yield, pool and labels
node src/decisionEvaluations/realDiffScreen/buildScan.ts       # pattern scan; read every hit
node src/decisionEvaluations/realDiffScreen/run.ts --split heldout --engines jev --out /tmp/heldout.json --source-revision <commit>
node src/decisionEvaluations/realDiffScreen/run.ts --rescore --out src/decisionEvaluations/realDiffScreen/results/heldout-jev.json --reclassified src/decisionEvaluations/realDiffScreen/results/flag-reading.json
```

`--rescore` rebuilds the summaries from the recorded calls without calling a provider. A test checks that the stored Jev summary follows from its records.

## Recommendation: stop, on the evidence so far (Jev, a diff-only question); one run could reverse it

On real diffs, Jev caught none of 30 attributed defects and the frozen heuristic baseline is at chance, so there is no evidence that a cheap model reading a diff catches the defects reviewers actually had to fix, and reading what it flags would not have saved work. The evidence for this is strong for what was measured (a one-question diff-only screen, Jev, 30 defects: an upper bound of 11% recall) and weak outside it: 23 of 30 defects need files the diff does not show, and Luna was not run.

What would change it:

- A Luna run that catches a meaningful share of the 30 defects at a low false-alarm rate on the same frozen cases (the commands are above), or Jev's ranking (AUC 0.63) turning out better with a different threshold on a larger set.
- Evidence that giving the engine the files a change touches, or asking one narrow question per defect kind (stale test, unhandled consumer), catches defects the diff alone hides. That is a different pilot, on its own frozen cases.
- Fewer truncated diffs: re-running the 20 truncated defects with the whole hunk in view.

Nothing here supports a lint rule, a gate or an automatic fix, and none is proposed.
