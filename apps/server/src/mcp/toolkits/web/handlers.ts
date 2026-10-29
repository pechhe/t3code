import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WebResearch from "../../WebResearch.ts";
import { WebToolkit } from "./tools.ts";

const service = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (
    scope.toolProfile !== "web-research" ||
    scope.webResearchTools !== true ||
    (scope.endpointKey !== "research" && scope.endpointKey !== "child-research")
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Web tools require a web-research session without native web tools.",
    });
  }
  return yield* WebResearch.WebResearch;
});
const failure = (error: WebResearch.WebResearchError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: error.message,
  });
export const layer = McpToolAccess.toLayer(WebToolkit, {
  web_search: McpToolAccess.reads((input) =>
    service.pipe(
      Effect.flatMap((web) => web.search(input)),
      Effect.catchTags({ WebResearchError: (error) => Effect.fail(failure(error)) }),
    ),
  ),
  web_fetch: McpToolAccess.reads((input) =>
    service.pipe(
      Effect.flatMap((web) => web.fetch(input)),
      Effect.catchTags({ WebResearchError: (error) => Effect.fail(failure(error)) }),
    ),
  ),
});
