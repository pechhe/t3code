import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as SlipJayGuard from "../../../project/SlipJayGuard.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [SlipJayGuard.SlipJayGuard],
};

/**
 * Pi decides its own permission policy in an extension, so its driver cannot answer
 * a command before the agent runs it; the injected extension asks this instead. The
 * decision is the repository's own `slipjay guard`, the same one every other driver
 * asks.
 */
const GuardCommandTool = Tool.make("t3_guard_command", {
  ...shared,
  description:
    "Ask the repository's SlipJay guard whether one shell command may run in a working directory. Returns the guard's own reason when it refuses. Built for T3's injected Pi extension, not for agent use.",
  parameters: Schema.Struct({
    cwd: TrimmedNonEmptyString,
    command: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({
    allowed: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const GuardToolkit = Toolkit.make(GuardCommandTool);
