# Testing

Rules for writing tests, and for asking for them in review.

## What to test

- Test behavior that can break, such as orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.
- DOM-level component behaviour has no automated test lane: the web client's Vitest browser suite is gone (T3-760), so a test that must render React has nowhere to run. Put what can be tested in the logic the component calls and cover it with a `*.logic.test.ts` unit test beside the module; leave the rendered pixels to a real client pass.
- In review, ask for a missing test only when it would catch a real regression. Do not ask for one assertion per constant, label, or `switch` case. Flag a new test that breaks the rules above, and name the fix: fold it into the existing case or table, delete it, keep one layer, or move an assertion that would pass without rendering into a unit test.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.

## Waiting for work

- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - A test that drives a real browser asserts by waiting on a condition, never on `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.

## Tests that launch a browser

- Real-Chromium tests are server tests: the page and managed-browser suites in `apps/server/src/preview` and the browser tasks in `apps/server/src/browserTasks`. They launch T3's own pinned chrome-headless-shell, resolved by `apps/server/src/testUtils/pinnedBrowser.ts` from a stable per-machine cache (`~/.cache/t3code`), so the ~128 MB download happens once rather than once per run. Do not add a Playwright browser download: `playwright-core` is T3's engine, and T3 supplies the browser.
- They skip when the pinned shell cannot be installed, so a run without one reports skips rather than failures. `T3CODE_TEST_BROWSER=none` asks for that run deliberately.

## Scenarios

Scenarios are [e2e](https://e2e.com/docs) tests in [`scripts/scenarios`](../../scripts/scenarios) (`*.e2e.ts`) that drive the real app (server, HTTP/WS, web browser or pooled iOS simulator) using the free `Replay (dev)` agent. Use one as real-app proof for a user-reproducible bug fix:

```sh
vp run scenarios                                                  # run all
vp run scenarios:prove scripts/scenarios/<name>.e2e.ts --base main --upload-command "ghdrop upload"
```

- One test per file (`WEB` from `./t3.ts` or `IOS` from `./t3-mobile.ts`). Seed projects and threads via `t3.project` / `t3.thread` before calling `t3.open(...)` so the app does not land on first-run setup.
- In web scenarios, navigate directly with `t3.open(thread)` or `t3.open("/settings/...")` unless the scenario exercises sidebar navigation.
- Put `expect` assertions only on the behavior the bug breaks, and take `app.screenshot("label")` where the bug shows so `scenarios:prove` pairs base and head captures. Never call `agent.act` or `agent.assert` (no model is configured).
- The app starts with a minimal env (`PATH`, `HOME`, temp dir); pass extra env vars via `T3_SCENARIO_INHERIT_ENV='VAR,PREFIX_*'`. Run one scenario run at a time per checkout.
- `scenarios:prove` exits `0` only when the test fails on base and passes on head (`1` = did not prove, `2` = app failed to start, `3` = scenario failed before its assertion). iOS scenarios lease a Simlock simulator and require `SIMLOCK_AGENT_DEVICE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`.
- Scenarios cannot cover desktop shell/IPC, Android, provider-specific protocol behavior (replay speaks generic ACP), or timing/perf regressions.
