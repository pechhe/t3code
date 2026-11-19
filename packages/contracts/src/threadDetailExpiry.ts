import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

/** Set when retention removed an item's or a subagent record's detail, leaving its timeline line. */
export const OrchestrationV2TurnItemDetailRemoved = Schema.Struct({
  at: IsoDateTime,
  /** Days the thread had been settled when its detail went. */
  afterDays: PositiveInt,
  /** UTF-8 bytes of the removed command output, which context estimates still count. */
  outputBytes: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationV2TurnItemDetailRemoved = typeof OrchestrationV2TurnItemDetailRemoved.Type;
