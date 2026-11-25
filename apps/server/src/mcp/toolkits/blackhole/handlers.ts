import * as Effect from "effect/Effect";

import * as BlackholeService from "../../../blackhole/BlackholeService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { RecallToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(RecallToolkit, {
  recall: McpToolAccess.reads(({ threadId, ...params }) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(threadId);
      const blackhole = yield* BlackholeService.BlackholeService;
      return yield* blackhole.recall(projection.thread.id, params);
    }),
  ),
});
