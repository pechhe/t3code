# Failed, blocked and interrupted attempts (T3-354)

Everything below is stated from the lead's session log. "Unknown" marks detail that was not retained.
Survivors (mutations no test noticed) are separate data: `corpus/attempts/*.json`, 26 of 47 labelled mutations.

| Attempt | What happened | Outcome | Retained |
|---|---|---|---|
| First labelling run (4 mutations: `packages/ssh/src/command.ts` L26 and L160, `apps/server/src/mcp/McpToolAccess.ts` L44 and L292) | The workspace's `vfile@6.0.3` install was incomplete (known SJ-194): server suites failed to import on the pristine source too. | Invalid. 23 of 46, 23 of 46, 27 of 30 and 27 of 30 candidates failed on both mutated and pristine source, so no mutation-caused failure was recorded (wall 70 s, 260 s, 39 s, 83 s). | Only this summary. The four per-case files were deleted as environment artefacts, which the first review correctly flagged as a gap; exit codes and per-file results are unknown. The ssh mutations were later re-run on the repaired install and also survived. |
| Repair | Missing files were copied additively from a complete sibling workspace's `vfile@6.0.3`. | Server suites imported again; one unrelated candidate fails on pristine source in every later case (`uncertain`). | n/a |
| Labelling chains interrupted by T3 server restarts (about five times) | The chain and its Vitest children were killed mid-mutation. | The mutated source was left on disk three times and restored with `jj restore` each time before continuing (`RecordingInput.ts`, `forgeLinks.ts`, `pierre-icons.ts`, `AgentRoleResolver.ts`, `handlers.ts`). The interrupted mutations were re-run; no result from an interrupted run is used. | Not retained. |
| Full-candidate hub labelling (`AgentRoleResolver.ts`, `RunMetrics.ts`, 166 and 178 candidates) | Did not finish before interruption (more than 10 minutes per mutation on a host at load 50 to 90). | Replaced by a seeded 60-test sample plus every mandatory test (`subsampledFrom` in each case). | Not retained. |
| First historical scoring run | Unpaced calls exceeded the shared 60/min admission window: 16 of 76 calls rejected `rate-limited` (7 Jev, 9 Luna). | Rejections are abstentions, never relevance. Re-run with 45/min pacing: 76 calls, 0 failures. | `results/historical-v1.attempt1-ratelimited.json` |
| Server-config attempt | `ConfigProvider.layer` on the service layer did not reach `Config` reads at call time; every call returned `unavailable`. | Fixed by providing the config per call (`engine.ts`). No provider call was charged. | Not retained. |
