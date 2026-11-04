import { canUseDecisions, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { assertLiveCaller, loadCaller } from "../../threadAccess.ts";
import { DecisionToolkit } from "./tools.ts";

const service = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (
    !canUseDecisions(scope) ||
    (scope.client !== undefined && McpInvocationContext.isReadOnlyClient(scope.client)) ||
    (scope.thread === undefined &&
      (scope.client === undefined || scope.managedProjectId === undefined))
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Decisions require an authenticated project caller with a decision-enabled tool profile.",
    });
  }
  const caller = yield* loadCaller();
  yield* assertLiveCaller(caller);
  if (
    caller.caller?.agentTask !== undefined &&
    !canUseDecisions({
      toolProfile: caller.caller.agentTask.toolProfile,
      agentRole: caller.caller.agentTask.role,
    })
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This managed role cannot invoke decisions.",
    });
  }
  return yield* DecisionService.DecisionService;
});
export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  t3_decide: McpToolAccess.reads((input) =>
    service.pipe(Effect.flatMap((decisions) => decisions.decide(input))),
  ),
});
