# Test authoring and focused verification

Read this before writing or changing tests, or choosing checks for a code change.

- Before an authorised push outside SlipJay, run `vp run check:changed`. SlipJay landings use the runner gate and focused local checks. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and the tests beside changes and those importing what changed. CI still runs the full test suites.
- While you iterate, run `vp test run <files>`. For big files, add `-t "<name>"`.
- Use `vp run typecheck`; it caches per package. Each package runs `effect-tsgo tsrs --noEmit`, the Rust TypeScript checker with Effect diagnostics.
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in the module's existing test file), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - A test that drives a real browser asserts by waiting on a condition, never on `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- DOM-level component behaviour has no automated test lane: the web client's Vitest browser suite is gone (T3-760), so a test that must render React has nowhere to run. Put what can be tested in the logic the component calls and cover it with a `*.logic.test.ts` unit test beside the module; leave the rendered pixels to a real client pass.
- Real-Chromium tests are server tests (the `apps/server/src/preview` page and managed-browser suites, and `apps/server/src/browserTasks`). They launch T3's own pinned chrome-headless-shell, resolved by `apps/server/src/testUtils/pinnedBrowser.ts` from a stable per-machine cache (`~/.cache/t3code`), so the ~128 MB download happens once rather than once per run, and they skip when it cannot be installed. Do not add a Playwright browser download.
