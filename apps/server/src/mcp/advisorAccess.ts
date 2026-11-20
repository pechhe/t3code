import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { assertBelowDelegationLimit } from "./delegationLimits.ts";
import type { Caller } from "./threadAccess.ts";

/** What a dedicated advisor's launch and control tools check of their caller. */
export const checkAdvisorCaller = (caller: Caller) =>
  (caller.caller?.agentTask?.sourceAccess === "read-only"
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "A read-only worker may consult its parent but cannot launch or control a dedicated advisor.",
        }),
      )
    : Effect.void
  ).pipe(
    Effect.andThen(
      caller.caller === undefined
        ? Effect.void
        : assertBelowDelegationLimit(caller.threads, caller.caller),
    ),
  );
