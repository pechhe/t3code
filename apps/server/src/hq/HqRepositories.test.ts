import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqRepositories from "./HqRepositories.ts";

it.effect("calls HQ's repository tools and decodes their values", () =>
  Effect.gen(function* () {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const repository = {
      key: "pechhe/yardsmith",
      name: "YardSmith",
      aliases: [],
      colour: "green",
      icon: { kind: "monogram", text: "YS" },
      revision: 3,
      updatedAt: "2026-10-20T12:00:00.000Z",
      updatedSource: "t3",
    } satisfies HqRepositories.Repository;
    const hq = yield* HqRepositories.HqRepositories.pipe(
      Effect.provide(
        HqRepositories.layer.pipe(
          Layer.provide(
            Layer.mock(HqAgentConnections.HqAgentConnections)({
              observe: (tool, args) =>
                Effect.sync(() => {
                  calls.push({ tool, args });
                  return {
                    origin: "https://hq.test",
                    connection: "one",
                    value: tool.endsWith("_list") ? [repository] : repository,
                  };
                }),
            }),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* hq.listRepositories(), [repository]);
    const input = {
      key: repository.key,
      colour: "green" as const,
      icon: { kind: "monogram" as const, text: "YS" },
    };
    assert.deepEqual(yield* hq.setRepository(input), repository);
    assert.deepEqual(calls, [
      { tool: "hq_build_repository_list", args: {} },
      { tool: "hq_build_repository_set", args: input },
    ]);
  }),
);

it.effect("rejects an invalid HQ response with a typed client error", () =>
  Effect.gen(function* () {
    const hq = yield* HqRepositories.HqRepositories.pipe(
      Effect.provide(
        HqRepositories.layer.pipe(
          Layer.provide(
            Layer.mock(HqAgentConnections.HqAgentConnections)({
              observe: () =>
                Effect.succeed({
                  origin: "https://hq.test",
                  connection: "one",
                  value: [{ colour: "invalid" }],
                }),
            }),
          ),
        ),
      ),
    );
    const result = yield* hq.listRepositories().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);
