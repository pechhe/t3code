import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import BrowserScriptRuns from "../persistence/Migrations/139_BrowserScriptRuns.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as BrowserRuns from "./BrowserRuns.ts";

const threadScope = (providerSessionId: string): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-browser-runs"),
  requestNamespace: "thread:browser-runs",
  thread: {
    threadId: ThreadId.make("thread-browser-runs"),
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("project-browser-runs"),
});

/** A preview manager whose tabs are owned by whatever owner key opened them. */
const previews = (open: Array<{ readonly tabId: string; readonly owner: string }>) => {
  const closed: Array<string> = [];
  const layer = Layer.mock(PreviewManager.PreviewManager)({
    list: () =>
      Effect.succeed({
        serverEpoch: "epoch",
        revision: 0,
        sessions: open
          .filter((tab) => !closed.includes(tab.tabId))
          .map(
            (tab) =>
              ({
                threadId: "thread-browser-runs",
                tabId: tab.tabId,
                automationOwner: tab.owner,
              }) as unknown as PreviewSessionSnapshot,
          ),
      }),
    close: ({ tabId }) => Effect.sync(() => void closed.push(tabId ?? "")),
  });
  return { closed, layer };
};

const recorded = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) =>
      sql<{ readonly outcome: string; readonly tabs: number; readonly thread_id: string | null }>`
        SELECT outcome, tabs, thread_id FROM browser_script_runs ORDER BY id
      `,
  ),
);

const harness = (open: Array<{ readonly tabId: string; readonly owner: string }>) => {
  const manager = previews(open);
  return {
    closed: manager.closed,
    layer: BrowserRuns.layer.pipe(
      Layer.provideMerge(manager.layer),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      Layer.provideMerge(NodeCrypto.layer),
    ),
  };
};

it.effect("ends a run at its time limit, closing only its own tabs and leaving one record", () => {
  const caller = threadScope("session-one");
  const open: Array<{ tabId: string; owner: string }> = [];
  const { closed, layer } = harness(open);
  return Effect.gen(function* () {
    yield* BrowserScriptRuns;
    const runs = yield* BrowserRuns.BrowserRuns;
    const run = yield* runs.open({
      caller,
      browserScope: () => caller,
      projectId: ProjectId.make("project-browser-runs"),
      timeLimitSeconds: 30,
    });
    const owner = McpInvocationContext.browserOwnerKey(run.scope);
    open.push({ tabId: "run-tab", owner }, { tabId: "own-preview-tab", owner: "someone-else" });
    yield* runs.noteTab(run.runId, "run-tab");

    // Another credential cannot use or close it.
    const stranger = threadScope("session-two");
    expect((yield* runs.use(stranger, run.runId).pipe(Effect.flip)).code).toBe("capability_denied");
    expect((yield* runs.use(caller, run.runId)).runId).toBe(run.runId);

    yield* TestClock.adjust(Duration.seconds(31));
    expect(closed).toEqual(["run-tab"]);
    expect((yield* runs.use(caller, run.runId).pipe(Effect.flip)).message).toContain(
      "No open browser run",
    );
    expect(yield* recorded).toEqual([
      { outcome: "time-limit", tabs: 1, thread_id: "thread-browser-runs" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("ends a run that goes over its output limit, and records a closed run's outcome", () => {
  const caller = threadScope("session-one");
  const { layer } = harness([]);
  return Effect.gen(function* () {
    yield* BrowserScriptRuns;
    const runs = yield* BrowserRuns.BrowserRuns;
    const open = (outputLimitBytes: number) =>
      runs.open({
        caller,
        browserScope: () => caller,
        projectId: ProjectId.make("project-browser-runs"),
        outputLimitBytes,
      });
    const small = yield* open(10);
    yield* runs.charge(small.runId, 6);
    expect((yield* runs.charge(small.runId, 6).pipe(Effect.flip)).message).toContain(
      "output limit",
    );
    expect(yield* runs.use(caller, small.runId).pipe(Effect.flip)).toBeDefined();

    const closing = yield* open(1_000);
    const summary = yield* runs.close(caller, closing.runId, "failed");
    expect(summary).toMatchObject({ runId: closing.runId, outcome: "failed", tabs: 0 });
    // The closed run's timer is gone: passing its limit records nothing more.
    yield* TestClock.adjust(Duration.seconds(BrowserRuns.BROWSER_RUN_LIMITS.defaultSeconds + 1));
    expect((yield* recorded).map((row) => row.outcome)).toEqual(["output-limit", "failed"]);
  }).pipe(Effect.provide(layer));
});
