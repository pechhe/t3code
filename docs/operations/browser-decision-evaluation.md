# Browser decision evaluation

Maintainer harness that compares bounded decision engines (Jev, GPT-6 Luna Decisions through `DecisionService`) with a managed browser worker on the same synthetic journeys. It changes no default, permission or gate.

## How a run works

- Fixtures (`browserDecisionEval/journeys.ts`) are local HTTP sites on ports 3100–3199, the range the installed server already allows for previews. Each records its own server-side facts; those, not the model's claim, grade the attempt. A journey either completes, or is expected to end `BLOCKED` with no forbidden effect (a credential submission or a wipe).
- `scripts/evaluate-browser-decisions.ts` drives an isolated managed integrated browser through `PreviewAutomationBroker` with a task-style scope (own thread, empty ephemeral context, loopback allow-list). Each step snapshots the page, asks one `DecisionService` batch for the operation and the target of each compatible operation, re-snapshots to check the chosen element is still the same, then acts. Stale choices are rejected, a refusal or service error executes nothing, and an abort stops the run and closes the tab.
- Typed values are fixed per journey and identical for every arm. A lone valid target is chosen locally without a model call (a deliberate harness bypass, not provider performance): the foundation at `a27df331` crashed on a one-label choice question. The foundation now requires at least two labels (`a412a7ae`, the base of every retained result), and the bypass remains because a single valid target needs no decision.
- Provider keys come from `TYPESAFE_API_KEY` and `OPENAI_API_KEY` in the environment. The service admits 60 calls a minute, so the script spaces decision calls 1.1 s apart and reports that waiting separately from active time.
- `scripts/serve-browser-fixtures.ts` serves the same fixtures for a worker arm: delegate a `browser` task (integrated) to a printed URL and read the recorded outcome from `outcomes.json`.

## Retained results (4 November 2026)

Every engine result ran from one source tree: foundation `a412a7ae` plus this change (`sourceTreeDigest` and per-file digests in `browser-decision-evaluation/results.json` identify the exact harness files). The worker arm used fixtures from `journeys.ts`, which was not edited afterwards. Raw per-attempt records, request digests, the worker prompt template and per-attempt worker receipts (delegated task name, start URL, claim, fixture outcome, thread timestamps) are in `results.json`.

| Arm                                                                            | Attempts            | Verified | False completions | Mean active time                             | Mean model time | Estimated cost per attempt |
| ------------------------------------------------------------------------------ | ------------------- | -------- | ----------------- | -------------------------------------------- | --------------- | -------------------------- |
| Jev `jev-1.14.0`                                                               | 27                  | 27       | 0                 | 4.5 s (median 3.8 s)                         | 0.71 s          | $0.00013                   |
| Luna `gpt-6-luna`                                                              | 27                  | 27       | 0                 | 5.0 s (median 4.1 s)                         | 1.02 s          | $0.00021                   |
| Managed browser worker (`pi`, `opencode-go/deepseek-v4.1-flash`, low thinking) | 9 (one per journey) | 9        | 0                 | 46.9 s (median 40.4 s, range 34.8 to 71.8 s) | not separable   | not reported               |

The 27 engine attempts per arm are three serial runs of each of nine journeys. Six are the initial journeys (navigation, form, screenshot target, recovery, an injected-instruction page and a blocked sign-in). Three were added after the first results to stress the engines: near-duplicate links, a multi-control form and a missing required value. Those three were chosen post hoc, so they are a stress set, not a held-out one. Both engines passed everything, so this run cannot separate their accuracy. Earlier pilot runs of the same journeys on pre-review code (36 and 18 attempts per engine, all verified) are not retained.

Concurrency 3 (one run of each journey per engine): 9/9 verified for each engine, no stray tabs, mean active time 4.4 s (Jev) and 4.3 s (Luna). Decision calls stay paced by the script, so this checks isolation under overlapping browsers, not throughput; timings vary with machine load. A cancellation probe aborted after the second decision: both engines stopped, did not run the second decision's action, made no further provider call and left no tab.

## What the evidence does and does not show

- On these synthetic pages a decision loop finished verified journeys in about five seconds where the worker took 35 to 72 seconds. Browser snapshots, freshness re-checks and actions are 80 to 84 percent of the loop's time, not the model, so the loop design matters more than the engine.
- The worker's time includes agent dispatch and its own reasoning, its model and prompt differ from the engines', and it ran once per journey. Treat the speed ratio as an upper bound on what adoption would give.
- Not shown: accuracy on real or changing sites, model-written field text, recovery from genuine page failures, long journeys, or any advantage of either engine. Worker usage and cost are not reported by the delegation API.
- The VPS is shared. A load average of about 90 on 14 cores was observed while the retained engine runs executed, and an attempt a few minutes earlier hit a 10 s Chromium launch timeout and a 15 s open timeout that ended the script, so absolute times are inflated and noisy; the worker runs were taken earlier at an unrecorded load. The harness now records a failed browser open as an errored attempt instead of ending the run.
- Mocks and replays appear only in offline tests; every number above comes from live provider calls and a real headless browser.
