import * as Effect from "effect/Effect";
import * as FleetSummaryService from "../../../fleet/FleetSummaryService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(FleetToolkit, {
  t3_fleet_summary: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* FleetSummaryService.FleetSummaryService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* service
        .summary(input, { localOnly: scope.client?.access === "peer-threads" })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: error.reason === "invalid_cursor" ? "invalid_request" : "orchestration_error",
                message: error.message,
              }),
          ),
        );
    }),
  ),
});
import { OrchestratorMcpFailure } from "@t3tools/contracts";
