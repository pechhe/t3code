# Thread housekeeping pilot (T3-575)

Offline, advisory: could a cheap bounded decision engine (Jev, Luna) take over two small chores that today cost a turn of an expensive model? It reads a read-only copy of the state database of this Mac and of peach-box, consumes the shared `DecisionService`, and changes no thread, role, default or turn path. Nothing here acts on a prediction or records one for a live thread. Titles are out of scope. The recommendation for each chore is the last section.

1. **Which project a "No project" chat belongs in.**
2. **Whether a wake carries anything new.**

Real thread text never enters the repository. Cases are built locally from the snapshots into a private file outside the checkout; `results/` holds only the sampling rule, case ids, digests, labels, agreement and aggregate results. The calls need that private file (`--cases`), and every case in it must match its committed digest.

## What was measured

### Cases and labels

Population and sampling are in `results/cases.json` (`samplingRule`, `population`). In short:

- **Project cases:** top-level chats that sat in "No project" with a first message of at least 15 characters. Moved chats (35 on the Mac, 12 on peach-box) are every chat that left "No project" and has a recorded run count at the move; stayed chats (55 and 5 held out) are chats still there. Most records of a project move in the database belong to delegated tasks given a project when created, so they are excluded: the real pool is small, which is why every moved chat is in the held-out set. Each is asked at every turn it spent in "No project", up to five (385 asks); the last turn is the headline, the first turn and every turn are shown beside it.
- **Wake cases:** a notification, or a message from a scheduled task, that is the first item of its run (it started a turn), 20 per kind per machine held out and 5 per kind per machine for tuning. Not judged and counted: a wake that steered a turn already running (241 delegated, 1,522 system, 12 timed, across both machines), and a wake whose run holds only that item, dropped without a turn (7 command, 10 delegated, 21 system, 2 watch, 1 timed). Wake kinds: delegated (delegated task or subagent), command (background command or monitor), watch (thread, Forge item or landing), timed (scheduled-task message) and system (the unattended nudge and context notices). 176 and 9 legacy untyped background-task items are left out.
- **Labels:** two blind labelers, neither an evaluated engine, read each case from the same text and labelled all 363 before any engine call. They never saw where the chat ended up or what the turn did. A split or any `unknown` is excluded from the headline figures and counted. A is the scout role (deepseek-v4.1-flash, low); B is the advisor role (claude-opus-5-5, medium), a different model family because the only other cheap non-engine model, the implementation worker's `sol` alias, was usage-limited and the scout role runs one model. Two blind labelers from different families are a weaker check than people.
- **Held-out set:** 107 project chats, 89 agreed (83 project, 6 none, 18 split or unknown), and 200 wakes, 177 agreed (128 something new, 49 nothing new; 23 split). Per kind, agreed nothing-new wakes: delegated 1, command 4, watch 5, timed 12, system 27. Tuning: 6 chats (3 agreed), 50 wakes (42 agreed). The tuning set fixed nothing but the by-kind baseline.

### Fixed shape of the evidence

For a project, at most 12 projects (most recently active first, as known when the chat began) each with its name, folder and 5 recent chat titles of 70 characters; the first message cut to 700 characters, up to two later user messages and the last assistant message cut to 400. For a wake, the thread's title, its 4 most recent messages (500 characters each) and the wake's source, outcome, summary and detail (1,000 each). Both stay far inside the service's 128 KiB limit. The questions are in `definitions.ts`; the engine sees nothing else (no destination, no baseline, no label).

### Declared floors (`policy.ts`, fixed before any held-out call)

A project pick counts only at 0.6 or more on the chosen label; otherwise the chat stays put. A wake counts as caught only when `nothing_new` has 0.8 or more. Other floors (0.6, 0.7, 0.9) appear as sensitivity, never as a headline.

### Baselines

- **Project:** the frozen keyword rule from T3-359 (copied, with its five project names, so a chat about T3 Peach, PropSmith, Splay or Homebase can only be none); what the agent actually did (the destination, or nothing); and never move.
- **Wake:** never catch (today); catch when the outcome is `updated`; catch a whole kind when at least half of its agreed tuning labels, and at least three, are nothing new (this caught only `system` and `timed`).

## Results (held-out, last turn in "No project"; matched or caught / scored, Wilson 95%)

### Project, 89 agreed chats

| System       | Matched label     | Wrong when it picked a project | Picked a project | "None" right of 6 | Chats the agent moved (39) | Chats left behind (50) |
| ------------ | ----------------- | ------------------------------ | ---------------- | ----------------- | -------------------------- | ---------------------- |
| Jev          | 50/89 (0.46-0.66) | 7/51 (0.07-0.26)               | 51               | 6                 | 18                         | 32                     |
| Luna         | 38/89 (0.33-0.53) | 7/39 (0.09-0.33)               | 39               | 6                 | 18                         | 20                     |
| Agent        | 38/89 (0.33-0.53) | 6/39 (0.07-0.30)               | 39               | 5                 | 33                         | 5                      |
| Keyword rule | 14/89 (0.10-0.25) | 33/41 (0.66-0.90)              | 41               | 6                 | 7                          | 7                      |
| Never move   | 6/89 (0.03-0.14)  | none picked                    | 0                | 6                 | 1                          | 5                      |

How often "none of these" was right when the system said it: Jev 6 of 38 (0.07-0.30), Luna 6 of 50 (0.06-0.24), agent 5 of 50 (0.04-0.21), keyword rule 6 of 48 (0.06-0.25), never-move 6 of 89 (0.03-0.14). The agent's score on the chats it moved is partly its own label: the labelers read the thread blind to the move but came to the same project in 33 of 39, which says the move was usually right, not that the engines are worse at filing chats the agent left alone. Over every turn rather than the last: Jev 79/154, Luna 70/154, agent 57/154; on the first turn alone Jev 44/89 and Luna 34/89, so the engine already does most of its work from the first message.

### Wake, by kind, at the declared 0.8 floor (nothing-new wakes caught / wrongly caught of the wakes that carried something)

| Kind (agreed nothing / something) | Spec mark      | Jev                               | Luna                                 | Rule by outcome  | Rule by kind     |
| --------------------------------- | -------------- | --------------------------------- | ------------------------------------ | ---------------- | ---------------- |
| delegated task (1 / 39)           | kept           | 0/1, 0/39                         | 0/1, 0/39                            | 0/1, 0/39        | 0/1, 0/39        |
| background command (4 / 34)       | kept           | 0/4, 0/34                         | 0/4, **7/34**                        | 0/4, 0/34        | 0/4, 0/34        |
| watch (5 / 29)                    | partly removed | 2/5, 0/29                         | 1/5, 1/29                            | 0/5, 2/29        | 0/5, 0/29        |
| timed check-back (12 / 13)        | partly removed | **9/12**, 0/13                    | 2/12, 0/13                           | 0/12, 0/13       | 12/12, **13/13** |
| system nudge (27 / 13)            | kept           | 3/27, 0/13                        | 9/27, 0/13                           | 27/27, **13/13** | 27/27, **13/13** |
| all kinds (49 / 128)              |                | 14/49 (0.18-0.42), 0/128 (0-0.03) | 12/49 (0.15-0.38), 8/128 (0.03-0.12) | 27/49, 15/128    | 39/49, 26/128    |

Never-catch (today) catches nothing and wrongly catches nothing. A kind's intervals at this size are wide (a kind with 5 nothing-new wakes cannot be told from 0.4 or 0.9); the file `results/heldout.json` has them all, and the sensitivity floors per engine and kind. The mark against T3-565 and T3-567 is as those two Specs are written on 10 Nov 2026 (`definitions.ts` has the reasons): neither removes the wakes of a finished delegated task, a finished command or a landing, and both only add wakes for targets that vanish; T3-567 parks slow watches (the wake on the event is kept) and turns one-off check-backs bound to their thread into time-parked waits, so part of the timed population goes; neither touches the unattended nudge or the rollover notices.

### What asking cost, and what the turns would have cost

Final held-out pass: Jev 385 calls, mean 189 ms (p50 181, max 548), 346,985 input and 23,736 output tokens, about $0.0146 by the service's price estimate; Luna 385 calls (one timed out, so its total stays unknown: $0.0242 estimated across the 384 that reported), mean 233 ms, 241,935 input tokens, output not reported. Estimates from the service, not invoices; the whole pilot (a tuning pass, two held-out passes, 1,700 calls) cost a few cents.

The state database records no token spend for a turn, so the spend of the turns a catcher would have replaced is **unknown**. It records the model, the wall time and the item count: for the 50 sampled turns of each wake kind, mostly claude-opus-5-5 (command 40 of 50, delegated 36, watch 35, timed 33, system 35), with median wall time 33-85 s and 7-13 items, the rest on sonnet-5-5, deepseek-v4.1-flash, gpt-6.1-sol, fable-5-2, luna and a free model (`results/cases.json`, `replacedTurns`). The project move turn was not measured: filing a chat is one agent action inside a longer turn, and its share of that turn's cost is not recorded either.

## Limits

- Labels come from two models, not people; they split on 18 of 107 chats and 23 of 200 wakes (15 of the 40 timed check-backs), and the engines, scout and advisor may share a bias. "Nothing new" is a judgement of the text shown, not of what the next turn did.
- The wake sample is balanced by kind, so figures across kinds are not population rates. Nothing-new wakes are rare in three kinds, so those rows carry almost no information.
- The project pool is every moved chat that exists (47), and the stayed sample (60 of 185) is hash-ordered; both are one operator's own chats on two machines.
- One call per ask and engine; a later pass on the same cases differed in the top label on 9 of 770 calls and changed no wake figure and at most one project figure (Jev 51 to 50 and Luna 37 to 38 matched, `results/first-run/`, made on source that differed only in comments and a test; its identity no longer matches the files). Luna timed out on one call in the final pass and on two in the first; Jev never failed.
- The keyword rule is T3-359's, frozen and unaware of three of this operator's projects.

## Reproducing

From `apps/server`, with the provider keys in the environment (`TYPESAFE_API_KEY` for Jev, `OPENAI_API_KEY` for Luna); never pass a key as an argument. The private cases file is built from the two snapshots by a local extraction script and kept outside the repository.

```sh
node src/decisionEvaluations/threadHousekeeping/run.ts --cases <private cases.json> --split heldout --out src/decisionEvaluations/threadHousekeeping/results/heldout.json --gap-ms 500
node src/decisionEvaluations/threadHousekeeping/run.ts --split heldout --rescore --out src/decisionEvaluations/threadHousekeeping/results/heldout.json   # no provider call, no private file
node src/decisionEvaluations/threadHousekeeping/buildRecord.ts --cases <private cases.json> --turns <turns.json>   # rebuilds results/cases.json
```

A rescore refuses if any file that decides what is asked has changed since the calls. `results/first-run/` holds an earlier pass of both splits. A different pilot's helpers are not imported: the interval, cost summary and keyword rule were copied (`scoring.ts`, `baseline.ts`) so another pilot's changes cannot move these figures.

## Recommendations

**Project filing: build a shadow trial, for Jev only, recording a suggestion and acting on nothing.** The need is real: of the 89 sampled chats whose labelers agreed, 83 belong in a project and only 6 in none, and 50 of those chats are still in "No project" today. Jev chose the labelled project (or "none") for 50 of the 89 (Wilson 0.46-0.66), against 38 for what the agent actually did (0.33-0.53), 38 for Luna and 14 for the frozen keyword rule (0.10-0.25). On the 50 chats the agent never filed, Jev was right on 32 (0.50-0.76) and Luna on 20. It is not good enough to act: when Jev picks a project above the 0.6 floor it is wrong 7 times in 51 (14%, 0.07-0.26), and on the 39 chats the agent did move it matched the label in 18 where the agent matched in 33. Run it live only as a recorded suggestion beside what the agent does, on the turn a chat is still in "No project", with the evidence shape above; keep the agent's own move as the decision. A recorded suggestion costs nothing when it is wrong (a few thousandths of a cent a call) and replaces two LLM labelers with real outcomes: whether the agent, or Henry, later files the chat where Jev said. The 14% wrong-pick rate is why it must not act yet, not a reason against measuring it. **What would change this:** over at least 150 live suggestions, a pick that disagrees with where the chat is actually filed more than 25% of the time would stop it; under 5% would justify letting a suggestion file the chat without an agent turn. Drop Luna: it was no better than the agent and timed out on one or two calls in each pass.

**Wake catching: revise, do not build a general catcher.** Across the delegated-task, command and watch wakes, a wake that brings nothing new is rare in this sample (1 of 40, 4 of 38 and 5 of 34 labelled), so there is almost nothing to catch and a catcher's only effect would be a wrongly caught result; Luna did exactly that on 7 of 34 command wakes. Only two kinds hold nothing-new wakes in quantity. For the timed check-back Jev caught 9 of the 12 nothing-new wakes (0.47-0.91) with no wrong catch in 13 (0-0.23), but 15 of the 40 labels were split, T3-567 turns one-off check-backs into parked waits and so removes part of that population, and the labelers are the weakest evidence here. For the system nudge ("Unattended: continuing the work" and the context notices) 27 of 40 were nothing new, yet Jev caught only 3 and Luna 9 at the 0.8 floor; a rule over the nudge's own text, which this pilot did not test, is the cheaper comparison. **What would change this:** re-sample after T3-565 and T3-567 land and rebuild a held-out set of at least 60 judged timed check-backs with a single labeller pair agreeing on most; a shadow trial of Jev on timed check-backs only is justified if its recall stays above 0.6 with no wrong catch in 60 or more something-new wakes. Stop work on delegated, command and watch wakes.
