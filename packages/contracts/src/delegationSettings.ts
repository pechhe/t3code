import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RuntimeMode } from "./providerPolicy.ts";

/** Settings → Delegation's runtime choices for delegated tasks, under ServerSettings' `delegation`. */
const DefaultChildRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
const AdvisorIdleCloseMinutes = Schema.NullOr(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10080 })),
);
export const DelegationRuntimeSettings = Schema.Struct({
  allowTrustedClaudeWriters: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultChildRuntimeMode: DefaultChildRuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("inherit" as const)),
  ),
  advisorIdleCloseMinutes: AdvisorIdleCloseMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** T3-574: asks the decision engine, off the delegation's path, which model it would pick. */
  modelShadow: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export const DelegationRuntimeSettingsPatch = Schema.Struct({
  allowTrustedClaudeWriters: Schema.optionalKey(Schema.Boolean),
  defaultChildRuntimeMode: Schema.optionalKey(DefaultChildRuntimeMode),
  advisorIdleCloseMinutes: Schema.optionalKey(AdvisorIdleCloseMinutes),
  modelShadow: Schema.optionalKey(Schema.Boolean),
});
export type DelegationRuntimeSettings = typeof DelegationRuntimeSettings.Type;
