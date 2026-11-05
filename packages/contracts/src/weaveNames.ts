import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Current names. `servers[1]` stays for native threads whose provider session began under it. */
export const WEAVE_NAMES = {
  servers: ["weave", "yardsmith-hq"],
  connectionTool: "t3_weave_connection",
  forgeToolPrefix: "weave_forge_",
} as const;

/** Project fields as fork clients older than the Weave names read and send them. */
export const RetainedWeaveProjectFields = {
  hqRepositoryKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  hqSyncLocalOnly: Schema.optional(Schema.Boolean),
  hqUnregisteredKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
};

/** Sign-in input as `hq.signIn.start` receives it from an older fork client. */
export const retainedWeaveSignInStartInput = <
  Input extends {
    readonly handbackOrigin: string;
    readonly weaveOrigin?: string | undefined;
    readonly hqOrigin?: string | undefined;
  },
>(
  input: Input,
) => ({
  handbackOrigin: input.handbackOrigin,
  weaveOrigin: input.weaveOrigin ?? input.hqOrigin,
});

export const withRetainedWeaveProjectFields = <
  Project extends {
    readonly weaveRepositoryKey?: string | null | undefined;
    readonly weaveSyncLocalOnly?: boolean | undefined;
    readonly weaveUnregisteredKey?: string | null | undefined;
  },
>(
  project: Project,
) => ({
  ...project,
  hqRepositoryKey: project.weaveRepositoryKey,
  hqSyncLocalOnly: project.weaveSyncLocalOnly,
  hqUnregisteredKey: project.weaveUnregisteredKey,
});
