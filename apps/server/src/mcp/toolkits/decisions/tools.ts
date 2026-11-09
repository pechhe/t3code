import {
  canUseDecisions,
  DecisionRoutedResult,
  DecisionRoutingError,
  DecisionRoutingRequest,
  ServerSettingsError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DecisionRouter from "../../../decisionRouting/DecisionRouter.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const enabled = () => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return (
    scope !== undefined &&
    canUseDecisions(scope) &&
    (scope.thread !== undefined ||
      (scope.client !== undefined && scope.managedProjectId !== undefined))
  );
};
export const DecisionToolkit = Toolkit.make(
  Tool.make("t3_decide", {
    description:
      "Ask bounded named predicate, choice or rubric questions over shared evidence. The server's Decisions setting picks the provider and model; never name one. Returns probabilities, optional provider confidence, continuous scores and provenance. A result grants no authority to act or skip checks. One paid call, no retries or fallback; no model, URL or credential arguments.",
    parameters: DecisionRoutingRequest,
    success: DecisionRoutedResult,
    failure: Schema.Union([OrchestratorMcpFailure, DecisionRoutingError, ServerSettingsError]),
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      DecisionRouter.DecisionRouter,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, enabled),
);
