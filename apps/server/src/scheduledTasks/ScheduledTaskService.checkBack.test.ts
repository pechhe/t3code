import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const NOW = "2026-11-10T12:00:00.000Z";
const RUN_AT = "2026-11-11T09:00:00.000Z";
const ONCE = `{"type":"once","runAt":"${RUN_AT}"}`;
const WEBHOOK = '{"type":"webhook","signature":null,"maxDeliveryAgeMinutes":null}';

interface Fixture {
  readonly id: string;
  readonly enabled?: number;
  readonly schedule?: string;
  readonly threadId?: string | null;
  readonly threadMode?: string;
  readonly role?: string | null;
  readonly next?: string | null;
}

const insert = (sql: SqlClient.SqlClient, fixture: Fixture) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: fixture.id,
    title: `Title ${fixture.id}`,
    prompt: `Prompt ${fixture.id}`,
    enabled: fixture.enabled ?? 1,
    schedule_json: fixture.schedule ?? ONCE,
    project_id: "project:test",
    thread_id: fixture.threadId === undefined ? "thread:own" : fixture.threadId,
    thread_mode: fixture.threadMode ?? "continue",
    purpose: "check_back",
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "agent",
    creation_source: "mcp",
    created_at: NOW,
    updated_at: NOW,
    next_run_at: fixture.next === undefined ? RUN_AT : fixture.next,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
    webhook_token: fixture.schedule === WEBHOOK ? "token" : null,
    group_id: null,
    agent_role: fixture.role === undefined ? "implementer" : fixture.role,
  })}`;

const fixtures: ReadonlyArray<Fixture> = [
  { id: "convertible" },
  { id: "repeating", schedule: '{"type":"interval","everyMs":3600000}' },
  { id: "webhook", schedule: WEBHOOK, next: null },
  { id: "unbound", threadId: null, threadMode: "new_thread" },
  { id: "fresh-session", threadMode: "fresh_session" },
  { id: "model-override", role: null },
  { id: "role-override", role: "reviewer" },
  { id: "disabled", enabled: 0 },
];

const layerFor = (dispatch: (command: unknown) => Effect.Effect<unknown, Error>) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: dispatch as never,
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
      ),
    ),
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const fixture of fixtures) yield* insert(sql, fixture);
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
  );

const remainingIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    task_id: string;
  }>`SELECT task_id FROM scheduled_tasks ORDER BY task_id`;
  return rows.map((row) => row.task_id);
});

it.live("turns only the convertible one-off check-back into a time-parked wait", () => {
  const dispatched: unknown[] = [];
  return Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    // The list changes once the converted task is gone, which happens after its dispatch.
    yield* service.subscribeList().pipe(
      Stream.filter(({ tasks }) => !tasks.some((task) => task.id === "convertible")),
      Stream.runHead,
    );
    assert.deepEqual(dispatched, [
      {
        type: "thread.thread-watch",
        commandId: "server:check-back-conversion:convertible",
        threadId: "thread:own",
        watching: true,
        target: { kind: "time", at: RUN_AT },
        park: { note: "Prompt convertible" },
        title: "Title convertible",
      },
    ]);
    assert.deepEqual(
      (yield* remainingIds).toSorted(),
      fixtures
        .map((fixture) => fixture.id)
        .filter((id) => id !== "convertible")
        .toSorted(),
    );
    const sql = yield* SqlClient.SqlClient;
    const kept = yield* sql<{ purpose: string; enabled: number; next_run_at: string | null }>`
      SELECT purpose, enabled, next_run_at FROM scheduled_tasks WHERE task_id = 'repeating'`;
    assert.deepEqual(kept[0], { purpose: "check_back", enabled: 1, next_run_at: RUN_AT });
  }).pipe(Effect.provide(layerFor((command) => Effect.sync(() => void dispatched.push(command)))));
});

it.live("keeps the task when the wait cannot be made, so nothing is lost", () =>
  Effect.gen(function* () {
    const refused = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      yield* Deferred.await(refused);
      assert.include(yield* remainingIds, "convertible");
    }).pipe(
      Effect.provide(
        layerFor(() =>
          Deferred.succeed(refused, undefined).pipe(
            Effect.andThen(Effect.die("refused")),
          ),
        ),
      ),
    );
  }),
);
