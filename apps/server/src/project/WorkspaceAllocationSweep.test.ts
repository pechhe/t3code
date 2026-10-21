import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspaceAllocationIntents from "../persistence/WorkspaceAllocationIntents.ts";
import * as Processes from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as WorkspaceAllocationSweep from "./WorkspaceAllocationSweep.ts";
import * as Workspaces from "./WorkspaceProvider.ts";

const output = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const layerIntents = WorkspaceAllocationIntents.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.layer(NodeServices.layer)("WorkspaceAllocationSweep", (it) => {
  it.effect(
    "releases a finished checkout nothing can adopt and settles one a thread is bound to",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const intents = yield* WorkspaceAllocationIntents.WorkspaceAllocationIntents;
        const addThread = (threadId: string, payload: object, deletedAt: string | null = null) =>
          sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, payload_json
          ) VALUES (
            ${threadId}, 'project-1', 'Thread', 'codex', 'full-access', 'default',
            '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z', ${deletedAt},
            ${JSON.stringify(payload)}
          )
        `;
        yield* addThread("bound", { worktreePath: "/ws/bound" });
        yield* addThread("attached", { workspaceAttachments: [{ workspacePath: "/ws/attached" }] });
        yield* addThread("removed", { worktreePath: "/ws/removed" }, "2026-10-21T10:00:00.000Z");
        yield* addThread("waiting", {});
        yield* addThread("cancelled", {});
        const addRun = (runId: string, threadId: string, status: string, ordinal = 1) =>
          sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id, thread_id, ordinal, provider, status, requested_at, payload_json
            ) VALUES (
              ${runId}, ${threadId}, ${ordinal}, 'codex', ${status}, '2026-10-21T09:00:00.000Z',
              ${JSON.stringify({ workspacePreparation: { type: "current" } })}
            )
          `;
        yield* addRun("run-waiting", "waiting", "failed");
        yield* addRun("run-cancelled", "cancelled", "cancelled");
        // An older failed run does not keep a newer run's checkout once a restart cancelled it.
        yield* addThread("superseded", {});
        yield* addRun("run-old", "superseded", "failed", 1);
        yield* addRun("run-new", "superseded", "cancelled", 2);
        const owners: Record<string, string> = {
          waiting: "waiting",
          restarted: "cancelled",
          newer: "superseded",
        };
        const paths = ["bound", "attached", "removed", "stray", "waiting", "restarted", "newer"];
        for (const name of paths)
          yield* intents.record({
            attemptId: name,
            projectRoot: "/project",
            ownerKind: "thread-launch",
            ownerRef: owners[name] ?? "missing-thread",
            createdAt: "2026-10-21T09:00:00.000Z",
          });
        const released: string[] = [];
        const layer = Layer.effect(
          Workspaces.WorkspaceProvider,
          Workspaces.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(Processes.ProcessRunner)({
                  run: (input) =>
                    Effect.sync(() => {
                      const [command, action, id] = input.args;
                      if (command !== "attempt") return output("");
                      if (action === "show")
                        return output(
                          JSON.stringify({
                            status: "ready",
                            workspacePath: `/ws/${id}`,
                            owned: true,
                            interrupted: false,
                          }),
                        );
                      released.push(id ?? "");
                      return output(JSON.stringify({ released: true, removed: `/ws/${id}` }));
                    }),
                }),
                Layer.mock(Git.GitVcsDriver)({}),
              ),
            ),
          ),
        );
        yield* WorkspaceAllocationSweep.sweep.pipe(Effect.provide(layer));
        // A deleted thread holds nothing, and a restart-cancelled launch cannot retry, so their
        // checkouts are given back with the stray one.
        expect(released).toEqual(["removed", "stray", "restarted", "newer"]);
        // Bound ones are settled without releasing anything; a launch whose thread still
        // exists keeps its checkout for the retry.
        expect((yield* intents.list).map((row) => row.attemptId)).toEqual(["waiting"]);
      }).pipe(Effect.provide(layerIntents)),
  );
});
