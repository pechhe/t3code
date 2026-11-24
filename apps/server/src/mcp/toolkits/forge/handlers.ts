import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ForgeReadService from "../../../weave/ForgeReadService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ForgeToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ForgeToolkit, {
  t3_forge_read: McpToolAccess.readsAsCaller(
    Effect.fn("ForgeHandlers.read")(function* (input) {
      if (!input.ref.trim()) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Give a non-empty Forge reference.",
        });
      }
      const forge = yield* ForgeReadService.ForgeReadService;
      return yield* forge
        .read(input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
    }),
  ),
});
