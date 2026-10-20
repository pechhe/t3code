import { ProjectIconColor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as HqAgentConnections from "./HqAgentConnections.ts";

const RepositoryIcon = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("monogram"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("lucide"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
]);
const Repository = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  colour: ProjectIconColor,
  icon: RepositoryIcon,
  revision: Schema.Number,
  updatedAt: Schema.String,
  updatedSource: Schema.Literals(["hq", "t3"]),
});
export type Repository = typeof Repository.Type;
// HQ lists every repository its Specs name, with a null revision until someone has edited it; only
// edited ones are records T3 can compare against.
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...Repository.fields,
      revision: Schema.NullOr(Schema.Number),
      updatedAt: Schema.NullOr(Schema.String),
      updatedSource: Schema.NullOr(Schema.Literals(["hq", "t3"])),
    }),
  ),
);
const decodeRepository = Schema.decodeUnknownEffect(Repository);

export class HqRepositoryError extends Schema.TaggedError<HqRepositoryError>()(
  "HqRepositoryError",
  {
    operation: Schema.Literals(["list", "set"]),
    cause: Schema.Defect(),
  },
) {}

export class HqRepositories extends Context.Service<
  HqRepositories,
  {
    readonly listRepositories: () => Effect.Effect<ReadonlyArray<Repository>, HqRepositoryError>;
    readonly setRepository: (input: {
      readonly key: string;
      readonly name?: string;
      readonly colour: ProjectIconColor;
      readonly icon: typeof RepositoryIcon.Type;
      readonly source: "t3";
    }) => Effect.Effect<Repository, HqRepositoryError>;
  }
>()("t3/hq/HqRepositories") {}

const make = Effect.gen(function* () {
  const hq = yield* HqAgentConnections.HqAgentConnections;
  return HqRepositories.of({
    listRepositories: Effect.fn("HqRepositories.listRepositories")(
      function* () {
        const result = yield* hq.observe("hq_build_repository_list", {});
        const listed = yield* decodeRepositories(result.value);
        return listed.flatMap((repository) =>
          repository.revision === null ||
          repository.updatedAt === null ||
          repository.updatedSource === null
            ? []
            : [
                {
                  ...repository,
                  revision: repository.revision,
                  updatedAt: repository.updatedAt,
                  updatedSource: repository.updatedSource,
                },
              ],
        );
      },
      Effect.mapError((cause) => new HqRepositoryError({ operation: "list", cause })),
    ),
    setRepository: Effect.fn("HqRepositories.setRepository")(
      function* (input) {
        const result = yield* hq.observe("hq_build_repository_set", { ...input });
        return yield* decodeRepository(result.value);
      },
      Effect.mapError((cause) => new HqRepositoryError({ operation: "set", cause })),
    ),
  });
});

export const layer = Layer.effect(HqRepositories, make);
