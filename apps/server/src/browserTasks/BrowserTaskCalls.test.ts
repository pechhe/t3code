import {
  OrchestratorMcpFailure,
  PREVIEW_TASK_REASON_FAULT,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentId,
  type PreviewTaskResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readTaskCallRows, summarizeTaskCalls } from "../cli/browserReport.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as BrowserTaskCalls from "./BrowserTaskCalls.ts";

const scope = (providerInstanceId: string): McpInvocationScope => ({
  environmentId: "environment" as EnvironmentId,
  requestNamespace: "thread:t",
  thread: {
    threadId: ThreadId.make("t"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
});

const result = (fields: Partial<PreviewTaskResult>): PreviewTaskResult => ({
  requestId: "r",
  tabId: PreviewTabId.make("tab"),
  status: "passed",
  actions: [],
  checksFinal: true,
  checks: [],
  evidence: { url: null, title: null, observedAt: null, ageMs: null, truncated: false },
  decisions: 0,
  usage: { inputTokens: 0, outputTokens: 0, usd: 0, unreportedCalls: 0, resolvedModels: [] },
  timings: { totalMs: 0, dispatchMs: 0, decisionMs: 0, browserMs: 0, waitMs: 0 },
  continuation: { state: "ready", guidance: "" },
  ...fields,
});

describe("PREVIEW_TASK_REASON_FAULT", () => {
  it("gives every reason exactly one of the four faults", () => {
    for (const fault of Object.values(PREVIEW_TASK_REASON_FAULT))
      expect(["request", "page-changed", "page-defect", "limit"]).toContain(fault);
  });
});

describe("BrowserTaskCalls", () => {
  it.effect("records every call, refused or run, and the report counts them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(dir, "state.sqlite");

      yield* Effect.gen(function* () {
        yield* runMigrations();
        const recorder = yield* BrowserTaskCalls.BrowserTaskCalls;
        const run = (
          provider: string,
          request: unknown,
          outcome: Effect.Effect<PreviewTaskResult, OrchestratorMcpFailure>,
        ) =>
          BrowserTaskCalls.recorded(Option.some(recorder), scope(provider), request, outcome).pipe(
            Effect.ignore,
          );

        yield* run("codex", { steps: [] }, Effect.succeed(result({ decisions: 0 })));
        yield* run(
          "codex",
          { goal: "g" },
          Effect.succeed(
            result({
              status: "blocked",
              reason: "stale-target",
              fault: "page-changed",
              decisions: 3,
            }),
          ),
        );
        // A repeat of a request id reads the earlier run: recorded, but not counted as a run.
        yield* run("codex", { goal: "g" }, Effect.succeed(result({ replayed: true })));
        yield* run(
          "pi",
          { goal: "g", pageReach: {} },
          Effect.fail(
            new OrchestratorMcpFailure({ code: "capability_denied", message: "Turned off." }),
          ),
        );
        yield* run(
          "pi",
          { steps: [] },
          Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: "Bad." })),
        );
        yield* recorder.record(scope("pi"), {
          ...BrowserTaskCalls.undecodedCall,
          mode: "goal",
          durationMs: 0,
        });
      }).pipe(
        Effect.provide(
          BrowserTaskCalls.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
        ),
      );

      const summary = summarizeTaskCalls(readTaskCallRows(filename, "1900-01-01T00:00:00.000Z"));
      expect(summary.calls).toBe(5);
      expect(summary.repeats).toBe(1);
      expect(summary.byHarness).toEqual([
        {
          key: "pi",
          calls: 3,
          outcomes: { passed: 0, blocked: 0, failed: 0, refused: 3, cancelled: 0 },
        },
        {
          key: "codex",
          calls: 2,
          outcomes: { passed: 1, blocked: 1, failed: 0, refused: 0, cancelled: 0 },
        },
      ]);
      expect(summary.byMode.map(({ key, calls }) => [key, calls])).toEqual([
        ["goal", 2],
        ["steps", 2],
        ["page-reach", 1],
      ]);
      expect(summary.byFault.map(({ key, calls }) => [key, calls])).toEqual([
        ["request", 2],
        ["limit", 1],
        ["none", 1],
        ["page-changed", 1],
      ]);
      // Nothing is read from a window the calls fall outside.
      expect(readTaskCallRows(filename, "2999-01-01T00:00:00.000Z")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
