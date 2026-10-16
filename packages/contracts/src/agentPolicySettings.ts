import * as Schema from "effect/Schema";
import {
  AgentExecutionRequirement,
  AgentExecutionBoundary,
  AgentPolicyManifest,
  AgentPolicySnapshot,
  Sha256,
} from "./agentPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ServerProvider } from "./server.ts";

export const AgentPolicyCandidate = Schema.Struct({
  alias: Schema.String,
  model: Schema.String,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  reason: Schema.String,
});
export type AgentPolicyCandidate = typeof AgentPolicyCandidate.Type;
export const AgentPolicyPreview = Schema.Struct({
  executionRequirement: Schema.optional(AgentExecutionRequirement),
  executionBoundary: Schema.optional(AgentExecutionBoundary),
  selection: Schema.NullOr(ModelSelection),
  refusal: Schema.NullOr(Schema.String),
  candidates: Schema.Array(AgentPolicyCandidate),
});
export type AgentPolicyPreview = typeof AgentPolicyPreview.Type;
export const AgentPolicySettings = Schema.Struct({
  snapshot: AgentPolicySnapshot,
  sourceRoot: Schema.String,
  /** Whether `roles/` has unsaved edits; kept for clients that predate `checkout`. */
  uncommitted: Schema.NullOr(Schema.Boolean),
  /** The installed agent-config checkout; null fields are unknown. Absent from older servers. */
  checkout: Schema.optional(
    Schema.Struct({
      revision: Schema.NullOr(Schema.String),
      hasLocalChanges: Schema.NullOr(Schema.Boolean),
      behindMain: Schema.NullOr(Schema.Number),
    }),
  ),
  providers: Schema.Array(ServerProvider),
});
export type AgentPolicySettings = typeof AgentPolicySettings.Type;
export const AgentPolicySaveInput = Schema.Struct({
  expectedHash: Sha256,
  manifest: AgentPolicyManifest,
});
export type AgentPolicySaveInput = typeof AgentPolicySaveInput.Type;
export class AgentPolicySettingsError extends Schema.TaggedError<AgentPolicySettingsError>()(
  "AgentPolicySettingsError",
  {
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.Literals([
      "not-configured",
      "busy",
      "read",
      "invalid",
      "stale",
      "write",
      "unsupported-model",
    ]),
  },
) {
  override get message(): string {
    return this.reason === "stale"
      ? "The policy changed on disk. Reload the current values before saving."
      : this.reason === "busy"
        ? "Another policy save is in progress. Try again."
        : `Delegation settings unavailable (${this.reason}).`;
  }
}
