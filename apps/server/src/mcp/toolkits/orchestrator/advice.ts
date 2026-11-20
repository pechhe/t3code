import {
  OrchestratorMcpAdvice,
  OrchestratorMcpAskAdviceInput,
  OrchestratorMcpAskAdviceWireInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { McpSchema, Tool } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AdviceMcpService from "../../AdviceMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** `ask_advice`'s definition; the toolkit adds its shared dependencies. */
export const askAdviceToolOptions = {
  description:
    "Consult your managed parent (default) or explicit advisor after investigating consequential ambiguity, a brief conflict or shared contracts. Decide routine reversible details locally. Supply question and stable clientRequestId; include the investigation and recommendation in the question or separate optional fields. blocking defaults true; set false when independent work can continue. Reuse the existing answer instead of acknowledging or repeating it. Blocking pending: end your turn; the answer wakes you. Nonblocking: continue independent work. read/answer/cancel use requestId and workerThreadId; only the immediate parent answers. Follow-ups need a fresh id, followsRequestId and newEvidence. A new advisor reads your workspace; sourceRevision pins it; taskId reuses that advisor. Advice grants no authority or human approval.",
  parameters: OrchestratorMcpAskAdviceWireInput,
  success: Schema.Union([OrchestratorMcpAdvice, OrchestratorMcpDelegateTaskResult]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
} as const;

export const AdvicePeerTool = Tool.make("t3_advice_peer", {
  description:
    "Internal delivery for the authenticated peer session that owns this managed delegation.",
  parameters: Schema.Struct({
    action: Schema.Literals(["read", "answer", "delivered", "wait", "cancel"]),
    workerThreadId: ThreadId,
    parentThreadId: ThreadId,
    seen: Schema.optional(Schema.String.check(Schema.isMaxLength(64_000))),
    requestId: Schema.optional(TrimmedNonEmptyString),
    answer: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Array(OrchestratorMcpAdvice),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, AdviceMcpService.AdviceMcpService],
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForLinkedEnvironments);

const decodeAdvice = Schema.decodeUnknownEffect(OrchestratorMcpAskAdviceInput);

export const executeAdvice = Effect.fn("AdviceMcp.execute")(function* (
  input: typeof OrchestratorMcpAskAdviceWireInput.Type,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const decoded = yield* decodeAdvice(input).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Ask requires structured question, evidence, recommendation, blocking and clientRequestId; read/cancel require requestId; answer also requires workerThreadId and answer.",
        }),
    ),
  );
  return yield* (yield* AdviceMcpService.AdviceMcpService).execute(scope, decoded);
});

export const advicePeer = Effect.fn("AdviceMcp.peer")(function* (
  input: typeof AdvicePeerTool.parametersSchema.Type,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return yield* (yield* AdviceMcpService.AdviceMcpService).peer(scope, input);
});
