import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import * as WeaveRepositories from "./WeaveRepositories.ts";

it.effect.each(["hq", "weave"] as const)(
  "decodes a repository a person last edited in Weave, recorded as %s",
  (updatedSource) =>
    Effect.gen(function* () {
      const repository = {
        key: "pechhe/yardsmith",
        name: "YardSmith",
        aliases: [],
        colour: "green",
        icon: { kind: "monogram", text: "YS" },
        revision: 3,
        updatedAt: "2026-10-20T12:00:00.000Z",
        updatedSource,
      } satisfies WeaveRepositories.Repository;
      const weave = yield* WeaveRepositories.WeaveRepositories.pipe(
        Effect.provide(
          WeaveRepositories.layer.pipe(
            Layer.provide(
              Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
                observe: () =>
                  Effect.succeed({
                    origin: "https://weave.test",
                    connection: "one",
                    value: [repository],
                  }),
              }),
            ),
          ),
        ),
      );
      assert.deepEqual(yield* weave.listRepositories(), [repository]);
    }),
);

it.effect("calls Weave's repository tools and decodes their values", () =>
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
    } satisfies WeaveRepositories.Repository;
    const weave = yield* WeaveRepositories.WeaveRepositories.pipe(
      Effect.provide(
        WeaveRepositories.layer.pipe(
          Layer.provide(
            Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
              observe: (tool, args) =>
                Effect.sync(() => {
                  calls.push({ tool, args });
                  return {
                    origin: "https://weave.test",
                    connection: "one",
                    value: tool.endsWith("_list") ? [repository] : repository,
                  };
                }),
            }),
          ),
        ),
      ),
    );
    assert.deepEqual(yield* weave.listRepositories(), [repository]);
    const input = {
      key: repository.key,
      colour: "green" as const,
      icon: { kind: "monogram" as const, text: "YS" },
    };
    assert.deepEqual(yield* weave.setRepository(input), repository);
    assert.deepEqual(calls, [
      { tool: "weave_forge_repository_list", args: {} },
      { tool: "weave_forge_repository_set", args: input },
    ]);
  }),
);

it.effect("rejects an invalid Weave response with a typed client error", () =>
  Effect.gen(function* () {
    const weave = yield* WeaveRepositories.WeaveRepositories.pipe(
      Effect.provide(
        WeaveRepositories.layer.pipe(
          Layer.provide(
            Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
              observe: () =>
                Effect.succeed({
                  origin: "https://weave.test",
                  connection: "one",
                  value: [{ colour: "invalid" }],
                }),
            }),
          ),
        ),
      ),
    );
    const result = yield* weave.listRepositories().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);
