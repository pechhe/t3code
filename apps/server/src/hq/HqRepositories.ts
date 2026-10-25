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
  // `registered`: the repository was registered in HQ and nobody has chosen its look yet.
  updatedSource: Schema.Literals(["hq", "t3", "registered"]),
});
export type Repository = typeof Repository.Type;
const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(Repository));
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
    }) => Effect.Effect<Repository, HqRepositoryError>;
  }
>()("t3/hq/HqRepositories") {}

const make = Effect.gen(function* () {
  const hq = yield* HqAgentConnections.HqAgentConnections;
  return HqRepositories.of({
    listRepositories: Effect.fn("HqRepositories.listRepositories")(
      function* () {
        const result = yield* hq.observe("hq_forge_repository_list", {});
        return yield* decodeRepositories(result.value);
      },
      Effect.mapError((cause) => new HqRepositoryError({ operation: "list", cause })),
    ),
    setRepository: Effect.fn("HqRepositories.setRepository")(
      function* (input) {
        const result = yield* hq.observe("hq_forge_repository_set", { ...input });
        return yield* decodeRepository(result.value);
      },
      Effect.mapError((cause) => new HqRepositoryError({ operation: "set", cause })),
    ),
  });
});

export const layer = Layer.effect(HqRepositories, make);
