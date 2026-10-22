import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SlipJayGuard from "../../../project/SlipJayGuard.ts";
import { GuardToolkit } from "./tools.ts";

export const guardLayer = SlipJayGuard.sharedLayer;

export const layer = McpToolAccess.toLayer(GuardToolkit, {
  t3_guard_command: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const guard = yield* SlipJayGuard.SlipJayGuard;
      const decision = yield* guard.check({ cwd: input.cwd, command: input.command });
      return { allowed: decision.allowed, reason: decision.reason };
    }),
  ),
});
