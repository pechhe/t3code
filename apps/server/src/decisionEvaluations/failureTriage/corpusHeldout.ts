import { AUTHENTIC_HELDOUT } from "./corpusAuthentic.ts";
import type { ResolvedCause, TriageCase, TriageEvidence } from "./corpusTypes.ts";

const none = "none supplied";
const syn = (label: ResolvedCause["label"]): ResolvedCause => ({
  label,
  basis: "Synthetic by construction.",
  confidence: "high",
});

const synthetic = (
  id: string,
  family: string,
  authorSupported: TriageCase["authorSupported"],
  resolved: ResolvedCause["label"],
  evidence: TriageEvidence,
): TriageCase => ({
  id,
  split: "heldout",
  family,
  stratum: "synthetic",
  authorSupported,
  resolvedCause: syn(resolved),
  evidence,
});

/** Symptoms rewritten from the fix commit's description of what failed; the explanation is withheld. */
const reconstructed = (
  id: string,
  authorSupported: TriageCase["authorSupported"],
  resolvedCause: ResolvedCause,
  evidence: TriageEvidence,
): TriageCase => ({
  id,
  split: "heldout",
  family: id,
  stratum: "reconstructed",
  authorSupported,
  resolvedCause,
  evidence,
});

export const HELDOUT_CASES: ReadonlyArray<TriageCase> = [
  ...AUTHENTIC_HELDOUT,
  reconstructed(
    "h-recon-partial-clone",
    "unknown",
    {
      label: "environment",
      basis:
        "f8abe60a9d: a global git url.insteadOf rewrite on the Mac and the runner (since 23 Oct) changed what `git remote -v` printed; the test asserted literal URLs.",
      confidence: "high",
    },
    {
      check: "pnpm run test:audit (nightly audit of main)",
      exitStatus: "nonzero_exit",
      failingTests: [
        "src/vcs/GitVcsDriver.test.ts > GitVcsDriver > reads a partial clone's annotated remote -v lines",
      ],
      firstError:
        "AssertionError: expected 'git@github.com:example/widgets.git' to equal 'https://github.com/example/widgets.git'",
      outputTail:
        " FAIL  src/vcs/GitVcsDriver.test.ts > GitVcsDriver > reads a partial clone's annotated remote -v lines\n ❯ src/vcs/GitVcsDriver.test.ts:612:36\n Test Files  1 failed | 1118 passed\n      Tests  1 failed | 11934 passed",
      changedSincePreviousAudit: { fileCount: 61 },
      recentHistory: [
        "GitVcsDriver.test.ts passed in every nightly audit up to the previous night",
      ],
      knownFlakeRegistry: none,
    },
  ),
  reconstructed(
    "h-recon-migration-list",
    "unknown",
    {
      label: "fixture",
      basis:
        "f8abe60a9d: an upstream reconcile renumbered migration 069 to 090 and the test's list of migrations an upgrade runs was left one entry short, failing since 25 Oct.",
      confidence: "high",
    },
    {
      check: "pnpm run test:audit (nightly audit of main)",
      exitStatus: "nonzero_exit",
      failingTests: [
        "src/persistence/Migrations/055_OrchestrationV2.test.ts > upgrade from schema 53 > runs the expected migrations",
      ],
      firstError:
        "AssertionError: expected [ 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90 ] to deeply equal [ 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89 ]",
      outputTail:
        " ❯ src/persistence/Migrations/055_OrchestrationV2.test.ts:88:34\n Test Files  1 failed | 1120 passed\n      Tests  1 failed | 11990 passed",
      changedSincePreviousAudit: {
        fileCount: 1742,
        firstFiles: [
          "fork/upstream-receipt.json",
          "apps/server/src/persistence/Migrations.ts",
          "apps/server/src/persistence/Migrations/090_ThreadMessageSearch.ts",
          "apps/server/src/persistence/Migrations/069_ProjectionAgentRuns.ts",
        ],
      },
      recentHistory: [
        "the previous nightly audit passed",
        "the commit under test is an upstream merge",
      ],
      knownFlakeRegistry: none,
    },
  ),
  reconstructed(
    "h-recon-electron-install",
    "unknown",
    {
      label: "fixture",
      basis:
        "7c9d0c400a: importing the real electron package without its binary runs its installer, so parallel desktop test files extracted the same archive over each other; fixed by stubbing electron in vitest.",
      confidence: "high",
    },
    {
      check: "vp test run --project desktop",
      exitStatus: "exit 1",
      failingTests: [
        "apps/desktop/src/main/windowState.test.ts > windowState > restores bounds",
        "apps/desktop/src/main/menu.test.ts > menu > builds the application menu",
      ],
      firstError:
        "Error: Electron failed to install correctly, please delete node_modules/electron and try installing again",
      outputTail:
        " FAIL  apps/desktop/src/main/menu.test.ts\n FAIL  apps/desktop/src/main/windowState.test.ts\n Test Files  2 failed | 21 passed (23)\n The same two files passed when run alone: `vp test run apps/desktop/src/main/menu.test.ts`.",
      change: "Edits a CSS file in apps/web only.",
      changedFiles: ["apps/web/src/index.css"],
      recentHistory: [
        "failed twice in the last 7 days on unrelated changes",
        "passed on rerun both times",
      ],
      knownFlakeRegistry: none,
    },
  ),
  synthetic("h-syn-regression-typecheck", "syn-h-1", "regression", "regression", {
    check: "pnpm exec vp run --filter t3 typecheck",
    exitStatus: "exit 2",
    failingTests: [],
    firstError:
      "apps/server/src/orchestration/projector.ts(212,40): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    outputTail: "Found 1 error in apps/server/src/orchestration/projector.ts:212",
    change: "Makes ThreadSummary.parentId optional in packages/contracts/src/orchestration.ts.",
    changedFiles: ["packages/contracts/src/orchestration.ts"],
    recentHistory: ["typecheck passed on the previous run of main"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-regression-deadlock", "syn-h-2", "regression", "regression", {
    check: "vp test run src/orchestration/ThreadRecovery.integration.test.ts",
    exitStatus: "exit 1",
    failingTests: ["ThreadRecovery > resumes a thread after a server restart"],
    firstError: "Error: Test timed out in 15000ms.",
    outputTail:
      " FAIL  ThreadRecovery.integration.test.ts > ThreadRecovery > resumes a thread after a server restart\n Test Files  1 failed (1)\n      Tests  1 failed | 8 passed (9)",
    change:
      "Adds an await on the checkpoint-capture Deferred inside resumeThread() in src/orchestration/ThreadRecovery.ts, before the resume event is published.",
    changedFiles: ["src/orchestration/ThreadRecovery.ts"],
    recentHistory: [
      "the test passed on its previous 200 runs, including 11 after unrelated changes",
      "no failure of this test has ever been recorded",
    ],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-regression-refused", "syn-h-3", "regression", "regression", {
    check: "vp test run src/server.integration.test.ts",
    exitStatus: "exit 1",
    failingTests: ["server > accepts a websocket connection on the configured host"],
    firstError: "Error: connect ECONNREFUSED 127.0.0.1:41807",
    outputTail:
      " FAIL  server.integration.test.ts > server > accepts a websocket connection on the configured host\n stdout | server started, listening on [::1]:41807\n Test Files  1 failed (1)",
    change:
      "Changes the default listen address in src/startup/listen.ts from 0.0.0.0 to the IPv6 loopback ::1.",
    changedFiles: ["src/startup/listen.ts"],
    recentHistory: ["the test passed on the previous 80 runs"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-regression-assertion", "syn-h-4", "regression", "regression", {
    check: "vp test run src/billing/proration.test.ts",
    exitStatus: "exit 1",
    failingTests: ["proration > charges the remaining 11 days of a 30 day period"],
    firstError: "AssertionError: expected 366 to be 367",
    outputTail:
      " FAIL  proration.test.ts > proration > charges the remaining 11 days of a 30 day period\n ❯ proration.test.ts:77:24",
    change:
      "Replaces Math.ceil with Math.round in prorate() in src/billing/proration.ts. proration.test.ts is unchanged.",
    changedFiles: ["src/billing/proration.ts"],
    recentHistory: ["the test passed on the previous 60 runs"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-regression-oom", "syn-h-5", "regression", "regression", {
    check: "vp test run --project server",
    exitStatus: "exit 137",
    failingTests: [],
    firstError: "Killed",
    outputTail:
      "runner memory: worker 3 resident 7.9 GB at kill (limit 8 GB); the last 20 completed runs of this job peaked at 2.0-2.3 GB\n[ELIFECYCLE] Command failed with exit code 137.",
    change:
      "Adds a process-wide Map in src/orchestration/EventCache.ts that retains every thread event for the life of the process.",
    changedFiles: ["src/orchestration/EventCache.ts", "src/orchestration/projector.ts"],
    recentHistory: ["the job passed on the previous run of main"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-fixture-stale-label", "syn-h-6", "fixture", "fixture", {
    check: "vp test run apps/web/src/components/Composer.test.tsx",
    exitStatus: "exit 1",
    failingTests: ["Composer > shows the send shortcut hint"],
    firstError: 'Error: expect(element).toHaveTextContent("Send (⌘↵)") Received: "Send ⌘↵"',
    outputTail:
      " FAIL  Composer.test.tsx > Composer > shows the send shortcut hint\n Test Files  1 failed | 14 passed",
    change:
      "Deliberately removes the parentheses from the send hint, following a design note in the ticket. Composer.test.tsx is not in the change.",
    changedFiles: ["apps/web/src/components/Composer.tsx"],
    recentHistory: ["Composer.test.tsx passed on the previous 50 runs of main"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-fixture-order", "syn-h-7", "fixture", "fixture", {
    check: "vp test run src/settings",
    exitStatus: "exit 1",
    failingTests: ["settings > defaults the theme to system"],
    firstError: "AssertionError: expected 'dark' to be 'system'",
    outputTail:
      ' FAIL  settings.test.ts > settings > defaults the theme to system\n Test Files  1 failed | 3 passed\n Re-run with only this test (-t "defaults the theme to system"): passed.',
    change:
      'Adds the test "persists a theme choice" to src/settings/settings.test.ts. No source file changed.',
    changedFiles: ["src/settings/settings.test.ts"],
    recentHistory: ["settings.test.ts passed on the previous 40 runs before this change"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-fixture-missing-file", "syn-h-8", "fixture", "fixture", {
    check: "vp test run src/replay/claude.replay.test.ts",
    exitStatus: "exit 1",
    failingTests: ["claude replay > variant 07"],
    firstError:
      "Error: ENOENT: no such file or directory, open 'src/replay/fixtures/claude-07.json'",
    outputTail:
      " FAIL  claude.replay.test.ts > claude replay > variant 07\n Test Files  1 failed | 1 passed",
    change:
      "Adds variant 07 to the replay test list in claude.replay.test.ts. The fixture file src/replay/fixtures/claude-07.json is not part of the change.",
    changedFiles: ["src/replay/claude.replay.test.ts"],
    recentHistory: ["the other 6 variants pass on this change"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-environment-registry", "syn-h-9", "environment", "environment", {
    check: "pnpm install --frozen-lockfile",
    exitStatus: "exit 1",
    failingTests: [],
    firstError:
      "ERR_PNPM_FETCH_502 GET https://registry.npmjs.org/effect/-/effect-4.0.6.tgz: Bad Gateway - 502 (retried 3 times)",
    outputTail:
      "Progress: resolved 1311, reused 1198, downloaded 102, added 0\n5 other jobs on the same runner pool failed at the same minute with ERR_PNPM_FETCH_502.",
    change: "Edits docs/user/threads.md only.",
    changedFiles: ["docs/user/threads.md"],
    recentHistory: ["a rerun of the identical commit 12 minutes later passed install"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-environment-disk", "syn-h-10", "environment", "environment", {
    check: "pnpm run build:web",
    exitStatus: "exit 1",
    failingTests: [],
    firstError: "Error: ENOSPC: no space left on device, write",
    outputTail:
      "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       100G  100G     0 100% /\nbuild stopped while writing dist/assets/index-4d2b.js",
    change: "Updates a unit test in apps/web/src/lib/format.test.ts.",
    changedFiles: ["apps/web/src/lib/format.test.ts"],
    recentHistory: ["the build passed on the previous run on a different runner"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-regression-looking-environment", "syn-h-11", "regression", "regression", {
    check: "vp test run src/net/relayClient.integration.test.ts",
    exitStatus: "exit 1",
    failingTests: ["relayClient > reconnects after the relay drops"],
    firstError: "Error: read ECONNRESET",
    outputTail:
      " FAIL  relayClient.integration.test.ts > relayClient > reconnects after the relay drops\n stderr | relay fixture: uncaught exception in handler: TypeError: Cannot read properties of undefined (reading 'close')\n stderr | relay fixture process exited with code 1\n Test Files  1 failed (1)",
    change:
      "Refactors connection teardown in src/net/relayServer.ts to move socket cleanup into a shared helper.",
    changedFiles: ["src/net/relayServer.ts", "src/net/closeSocket.ts"],
    recentHistory: ["the test passed on the previous 90 runs"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-flake-registered", "syn-h-12", "known-flake", "known-flake", {
    check: "playwright test e2e/composer-attachments.spec.ts",
    exitStatus: "exit 1",
    failingTests: ["composer-attachments.spec.ts > pastes an image"],
    firstError: "Error: locator.click: Target closed",
    outputTail:
      " 1) composer-attachments.spec.ts:34:3 > pastes an image\n    Error: locator.click: Target closed\n 1 failed, 18 passed\n retry #1 of the same shard: 19 passed",
    change: "Updates an unrelated copy string in apps/web/src/i18n/en.json.",
    changedFiles: ["apps/web/src/i18n/en.json"],
    recentHistory: [
      "a retry of the identical commit passed",
      "failed identically on 3 of the last 50 runs of main at different commits",
    ],
    knownFlakeRegistry: [
      "composer-attachments.spec.ts > pastes an image: recorded intermittent 'Target closed', Forge #4690, open since 2026-09-30",
    ],
  }),
  synthetic("h-syn-flake-registered-different-error", "syn-h-13", "unknown", "regression", {
    check: "playwright test e2e/thread-switch.spec.ts",
    exitStatus: "exit 1",
    failingTests: ["thread-switch.spec.ts > restores the draft of the previous thread"],
    firstError: 'Error: expect(received).toHaveValue(expected)\nExpected: "hello"\nReceived: ""',
    outputTail: " 1 failed, 18 passed\n no retry has been run",
    change:
      "Changes draft persistence in apps/web/src/composerDraftStore.ts so drafts are keyed by thread id and environment id.",
    changedFiles: ["apps/web/src/composerDraftStore.ts"],
    recentHistory: ["this test has not failed before"],
    knownFlakeRegistry: [
      "thread-switch.spec.ts > restores the draft of the previous thread: recorded intermittent 'Timeout 30000ms exceeded', Forge #4533, open",
    ],
  }),
  synthetic("h-syn-flake-registered-no-rerun", "syn-h-14", "known-flake", "known-flake", {
    check: "vp test run src/process/ProcessSupervisor.test.ts",
    exitStatus: "exit 1",
    failingTests: ["ProcessSupervisor > reaps a child that ignores SIGTERM"],
    firstError: "Error: Test timed out in 15000ms.",
    outputTail:
      " FAIL  ProcessSupervisor.test.ts > ProcessSupervisor > reaps a child that ignores SIGTERM\n Test Files  1 failed | 4 passed",
    change: "Bumps a dev dependency (oxlint) patch version in package.json.",
    changedFiles: ["package.json", "pnpm-lock.yaml"],
    recentHistory: [
      "failed identically on 4 of the last 60 runs of main at different commits",
      "no rerun of this commit yet",
    ],
    knownFlakeRegistry: [
      "ProcessSupervisor > reaps a child that ignores SIGTERM: recorded intermittent timeout 'Test timed out in 15000ms', Forge #4248, open",
    ],
  }),
  synthetic("h-syn-unknown-bare-exit", "syn-h-15", "unknown", "unknown", {
    check: "pnpm run test:landing",
    exitStatus: "exit 1",
    failingTests: [],
    firstError: "",
    outputTail:
      "...[output truncated: 18,204 lines omitted]\n[ELIFECYCLE] Command failed with exit code 1.",
    change: "Adds a new server route in src/http/routes/export.ts.",
    changedFiles: ["src/http/routes/export.ts"],
    recentHistory: ["no history supplied"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-unknown-preexisting", "syn-h-16", "unknown", "unknown", {
    check: "vp test run src/search/threadSearch.test.ts",
    exitStatus: "exit 1",
    failingTests: ["threadSearch > ranks title matches above body matches"],
    firstError: "AssertionError: expected [ 'b', 'a', 'c' ] to deeply equal [ 'a', 'b', 'c' ]",
    outputTail:
      " FAIL  threadSearch.test.ts > threadSearch > ranks title matches above body matches\n ❯ threadSearch.test.ts:140:22",
    change:
      "Adds an index to a SQLite migration for an unrelated table. The failing module is not among the changed files.",
    changedFiles: ["apps/server/src/persistence/Migrations/091_AddAuditIndex.ts"],
    recentHistory: [
      "the same test failed on the previous 3 runs of main at older commits",
      "it passed 5 days earlier",
      "no commit touching src/search has landed in those 5 days",
    ],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-unknown-cut-timeout", "syn-h-17", "unknown", "unknown", {
    check: "vp test run --project server --shard 3/6",
    exitStatus: "exit 124",
    failingTests: [],
    firstError: "",
    outputTail:
      "[runner] shard 3/6 exceeded its 25 minute budget and was terminated\n stdout | ...[output truncated]",
    change: "Splits one server test file into two.",
    changedFiles: [
      "src/persistence/replay.test.ts",
      "src/persistence/replay.claude.test.ts",
      "src/persistence/replay.codex.test.ts",
    ],
    recentHistory: ["this shard's last 10 runs took between 14 and 19 minutes"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-unknown-e2e-timeout", "syn-h-18", "unknown", "unknown", {
    check: "playwright test e2e/sidebar.spec.ts",
    exitStatus: "exit 1",
    failingTests: ["sidebar.spec.ts > opens the project switcher"],
    firstError:
      "Error: locator.click: Timeout 30000ms exceeded.\n waiting for getByRole('button', { name: 'Switch project' })",
    outputTail: " 1 failed, 24 passed\n no retry has been run",
    change:
      "Moves the project switcher from the sidebar header into a menu in apps/web/src/components/ProjectMenu.tsx.",
    changedFiles: [
      "apps/web/src/components/ProjectMenu.tsx",
      "apps/web/src/components/Sidebar.tsx",
    ],
    recentHistory: ["this test has passed on its previous 120 runs"],
    knownFlakeRegistry: none,
  }),
  synthetic("h-syn-unknown-hook", "syn-h-19", "unknown", "unknown", {
    check: "pre-push hook",
    exitStatus: "exit 1",
    failingTests: [],
    firstError: "husky - pre-push script failed (code 1)",
    outputTail: "husky - pre-push script failed (code 1)\nerror: failed to push some refs",
    recentHistory: ["no history supplied"],
    knownFlakeRegistry: none,
  }),
];
