import { ProjectIconColor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

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
  // `registered`: the repository was registered in Weave and nobody has chosen its look yet.
  // Weave's own value for a person's edit: `hq` until its rename reaches every stored row.
  updatedSource: Schema.Literals(["hq", "weave", "t3", "registered"]),
});
export type Repository = typeof Repository.Type;
const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(Repository));
const decodeRepository = Schema.decodeUnknownEffect(Repository);

export class WeaveRepositoryError extends Schema.TaggedError<WeaveRepositoryError>()(
  "WeaveRepositoryError",
  {
    operation: Schema.Literals(["list", "set"]),
    cause: Schema.Defect(),
  },
) {}

export class WeaveRepositories extends Context.Service<
  WeaveRepositories,
  {
    readonly listRepositories: () => Effect.Effect<ReadonlyArray<Repository>, WeaveRepositoryError>;
    readonly setRepository: (input: {
      readonly key: string;
      readonly name?: string;
      readonly colour: ProjectIconColor;
      readonly icon: typeof RepositoryIcon.Type;
    }) => Effect.Effect<Repository, WeaveRepositoryError>;
  }
>()("t3/weave/WeaveRepositories") {}

const make = Effect.gen(function* () {
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  return WeaveRepositories.of({
    listRepositories: Effect.fn("WeaveRepositories.listRepositories")(
      function* () {
        const result = yield* weave.observe("weave_forge_repository_list", {});
        return yield* decodeRepositories(result.value);
      },
      Effect.mapError((cause) => new WeaveRepositoryError({ operation: "list", cause })),
    ),
    setRepository: Effect.fn("WeaveRepositories.setRepository")(
      function* (input) {
        const result = yield* weave.observe("weave_forge_repository_set", { ...input });
        return yield* decodeRepository(result.value);
      },
      Effect.mapError((cause) => new WeaveRepositoryError({ operation: "set", cause })),
    ),
  });
});

export const layer = Layer.effect(WeaveRepositories, make);
