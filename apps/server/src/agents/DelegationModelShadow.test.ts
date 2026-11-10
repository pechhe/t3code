import {
  DecisionRoutingError,
  type DecisionRoutedResult,
  type DecisionRoutingFailureCode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Shadow from "./DelegationModelShadow.ts";

const answered = (choice: string, probability: number): DecisionRoutedResult => ({
  provider: "jev",
  requestedModel: "jev-1.14.0",
  resolvedModel: "jev-1.14.0",
  adapterVersion: "test",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 7,
  usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null },
  cost: { usd: 0, status: "estimated", pricingSource: "t", inputUsdPerMillion: 1 },
  answers: [
    {
      id: "model",
      status: "answered",
      type: "choice",
      choice,
      selectedChoiceProbability: probability,
      probabilities: { [choice]: probability },
      confidence: 0.5,
    },
  ],
});

const eligible = [
  { model: "cheap-model", note: "quick edits" },
  { model: "strong-model", note: "hard design" },
];
const secret = "PRIVATE-TASK-TEXT";
const observation = (threadId: string, models = eligible) => ({
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("p"),
  role: "implementer" as const,
  taskClass: "non-ui" as const,
  eligible: Effect.succeed(models),
  chosenModel: "strong-model",
  reassigned: false,
  taskText: `${secret} do the thing`,
});

const run = <A>(
  decide: DecisionRouter.DecisionRouter["Service"]["decide"],
  options: { readonly on?: boolean },
  body: (
    shadow: Shadow.DelegationModelShadow["Service"],
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, SqlError.SqlError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* Effect.gen(function* () {
      yield* runMigrations();
      return yield* body(yield* Shadow.DelegationModelShadow, yield* SqlClient.SqlClient);
    }).pipe(
      Effect.provide(
        Shadow.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(DecisionRouter.DecisionRouter)({ decide }),
              ServerSettings.ServerSettingsService.layerTest({
                delegation: { modelShadow: options.on ?? true },
              }),
            ),
          ),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: path.join(dir, "state.sqlite") })),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const rows = (sql: SqlClient.SqlClient) =>
  sql<Record<string, unknown>>`SELECT * FROM delegation_model_shadow ORDER BY id`;

describe("DelegationModelShadow", () => {
  it.effect("records the pick, its probability and the eligible list, never the task text", () => {
    const sent: unknown[] = [];
    return run(
      (input) => Effect.sync(() => (sent.push(input), answered("m1", 0.9))),
      {},
      (shadow, sql) =>
        Effect.gen(function* () {
          yield* shadow.record(observation("t1"));
          const [row] = yield* rows(sql);
          expect(row).toMatchObject({
            thread_id: "t1",
            role: "implementer",
            task_class: "non-ui",
            chosen_model: "strong-model",
            status: "recommended",
            pick_model: "cheap-model",
            probability: 0.9,
            confidence: 0.5,
            floor: Shadow.SHADOW_PROBABILITY_FLOOR,
            provider: "jev",
            reassigned: 0,
          });
          expect(JSON.parse(String(row!.eligible_json))).toEqual(["cheap-model", "strong-model"]);
          expect(JSON.stringify(row)).not.toContain(secret);
          // The engine sees the task and each model's note, as the delegating agent does.
          expect(JSON.stringify(sent)).toContain(secret);
          expect(JSON.stringify(sent)).toContain("hard design");
        }),
    );
  });

  it.effect("calls an answer below the floor an abstention, not a recommendation", () =>
    run(
      () => Effect.succeed(answered("m2", Shadow.SHADOW_PROBABILITY_FLOOR - 0.01)),
      {},
      (shadow, sql) =>
        Effect.gen(function* () {
          yield* shadow.record(observation("t1"));
          expect((yield* rows(sql))[0]).toMatchObject({
            status: "abstained",
            pick_model: "strong-model",
          });
        }),
    ),
  );

  it.effect("asks nothing and records nothing while the pilot is off", () => {
    let calls = 0;
    return run(
      () => Effect.sync(() => (calls++, answered("m1", 0.9))),
      { on: false },
      (shadow, sql) =>
        Effect.gen(function* () {
          yield* shadow.record(observation("t1"));
          expect(calls).toBe(0);
          expect(yield* rows(sql)).toHaveLength(0);
        }),
    );
  });

  it.effect("asks once per delegation and skips the engine for a lone eligible model", () => {
    let calls = 0;
    return run(
      () => Effect.sync(() => (calls++, answered("m1", 0.9))),
      {},
      (shadow, sql) =>
        Effect.gen(function* () {
          yield* shadow.record(observation("t1"));
          yield* shadow.record(observation("t1"));
          yield* shadow.record(observation("t2", [eligible[0]!]));
          expect(calls).toBe(1);
          expect((yield* rows(sql)).map((row) => row.status)).toEqual([
            "recommended",
            "sole-model",
          ]);
        }),
    );
  });

  it.effect.each(["unreachable", "timeout", "rate-limited"] satisfies DecisionRoutingFailureCode[])(
    "records a %s provider as a failure with no pick, and returns normally",
    (code) =>
      run(
        () => Effect.fail(new DecisionRoutingError({ provider: "jev", code })),
        {},
        (shadow, sql) =>
          Effect.gen(function* () {
            yield* shadow.record(observation("t1"));
            expect((yield* rows(sql))[0]).toMatchObject({
              status: "failed",
              error_code: code,
              pick_model: null,
              probability: null,
            });
          }),
      ),
  );

  it.effect("returns at once, and fails nothing, while the provider never answers", () =>
    run(
      () => Effect.never,
      {},
      (shadow) => shadow.observe(observation("t1")),
    ),
  );
});
