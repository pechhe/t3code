import type {
  AgentPolicySnapshot,
  AgentTaskRequest,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
  ServerProvider,
  AgentPolicyPreview,
} from "@t3tools/contracts";
import { AgentPolicyCandidate } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { compareByUsageReset } from "../provider/providerPools.ts";

export class AgentRoleError extends Schema.TaggedError<AgentRoleError>()("AgentRoleError", {
  reason: Schema.Literals([
    "classification",
    "no-eligible-model",
    "selection-denied",
    "unsupported-tools",
    "unsupported-permissions",
    "unsupported-options",
    "source-pin-required",
    "review-scope-required",
    "review-scope-invalid",
    "author-provider-required",
  ]),
  candidates: Schema.optional(Schema.Array(AgentPolicyCandidate)),
}) {
  override get message(): string {
    return `Managed agent request refused (${this.reason}).`;
  }
}

/**
 * A model a caller or experiment asks for within a role. Without an instance, any eligible
 * account offering the model may serve it; without options, the role's own effort applies.
 */
export type RequestedModel = {
  readonly instanceId?: ProviderInstanceId;
  readonly model: string;
  readonly options?: ModelSelection["options"];
};

type ResolutionInput = {
  readonly snapshot: AgentPolicySnapshot;
  readonly request: AgentTaskRequest;
  /** Already intersected with the project's enabled and caller-authorized accounts. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly ceiling: RuntimeMode;
  readonly currentInstanceId?: ProviderInstanceId;
  readonly selection?: RequestedModel;
};

export class AgentRoleResolver extends Context.Service<
  AgentRoleResolver,
  {
    readonly resolve: (input: ResolutionInput) => Effect.Effect<ModelSelection, AgentRoleError>;
    readonly preview: (input: ResolutionInput) => Effect.Effect<AgentPolicyPreview>;
  }
>()("t3/agents/AgentRoleResolver") {}

const inspect = Effect.fn("AgentRoleResolver.inspect")(function* (input: ResolutionInput) {
  const { request, snapshot } = input;
  const role = snapshot.manifest.roles[request.role];
  if (!role.taskClasses.includes(request.taskClass))
    return yield* new AgentRoleError({ reason: "classification" });
  if (request.role === "reviewer" && request.sourceRevision === undefined)
    return yield* new AgentRoleError({ reason: "source-pin-required" });
  const review = request.review;
  if (request.role === "reviewer" && review === undefined)
    return yield* new AgentRoleError({ reason: "review-scope-required" });
  if (
    review !== undefined &&
    (request.role !== "reviewer" ||
      (review.scope === "change" && review.includedChanges.length === 0) ||
      (review.scope === "spec" &&
        (review.specRef === undefined || review.specRevision === undefined)) ||
      // A delta covers exactly the material changes since the earlier report.
      (review.priorReview !== undefined &&
        (review.priorReview.sourceRevision !== review.baseRevision ||
          review.priorReview.sourceRevision === request.sourceRevision)))
  )
    return yield* new AgentRoleError({ reason: "review-scope-invalid" });
  // Phi needs an attested, restricted tool transport. A general shell or native browser
  // is not a substitute; advertise refusal until that route can enforce its contract.
  if (role.toolProfile === "phi") return yield* new AgentRoleError({ reason: "unsupported-tools" });
  const readOnly = role.sourceAccess === "read-only" || request.readOnly === true;
  if (!readOnly && input.ceiling === "approval-required")
    return yield* new AgentRoleError({ reason: "unsupported-permissions" });
  const pool = snapshot.manifest.pools[role.pool];
  const allowed = role.restrictions[request.taskClass] ?? pool.allow;
  const diagnostics: Array<AgentPolicyCandidate> = [];
  const record = (
    alias: string,
    model: string,
    reason: string,
    providerInstanceId?: ProviderInstanceId,
  ) => {
    const candidate = {
      alias,
      model,
      reason,
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    };
    diagnostics.push(candidate);
    return candidate;
  };
  const authorDrivers = new Set(
    Object.values(snapshot.manifest.models)
      .filter((model) => model.model === request.authorModel)
      .map((model) => model.driverKind),
  );
  const authorDriver = authorDrivers.size === 1 ? [...authorDrivers][0] : undefined;
  if (
    request.role === "reviewer" &&
    snapshot.manifest.reviewer?.requireDifferentProvider &&
    authorDriver === undefined
  )
    return yield* new AgentRoleError({ reason: "author-provider-required" });
  const eligible: Array<{ selection: ModelSelection; alias: string; provider: ServerProvider }> =
    [];
  for (const [alias, binding] of Object.entries(snapshot.manifest.models)) {
    const effort = request.demanding ? role.effort[alias]?.demanding : role.effort[alias]?.default;
    if (!pool.allow.includes(alias)) {
      record(alias, binding.model, "outside-pool");
      continue;
    }
    if (!allowed.includes(alias)) {
      record(alias, binding.model, "task-restriction");
      continue;
    }
    if (effort === undefined) {
      record(alias, binding.model, "unsupported-effort");
      continue;
    }
    // Managed enforcement is implemented only in these adapters. Custom model aliases
    // must still resolve to the advertised literal model; no inherited-model fallback.
    if (binding.driverKind !== "codex" && binding.driverKind !== "claudeAgent") {
      record(alias, binding.model, "unsupported-provider");
      continue;
    }
    if (
      request.taskClass !== "non-ui" &&
      (binding.driverKind === "codex" || /^(gpt-|o[134]-)/i.test(binding.model))
    ) {
      record(alias, binding.model, "ui-model-restriction");
      continue;
    }
    // Claude's existing read-only tool whitelist is enforceable. Its workspaceWrite
    // policy currently maps to permission modes, not an isolated source-write boundary.
    if (!readOnly && binding.driverKind === "claudeAgent") {
      record(alias, binding.model, "claude-writer-boundary-unavailable");
      continue;
    }
    const providers = input.providers.filter(
      (provider) => provider.poolMembers === undefined && provider.driver === binding.driverKind,
    );
    if (providers.length === 0) record(alias, binding.model, "provider-not-installed");
    for (const provider of providers) {
      const skip = (reason: string) => record(alias, binding.model, reason, provider.instanceId);
      if (!provider.enabled || provider.status === "disabled") {
        skip("provider-disabled");
        continue;
      }
      if (!provider.installed) {
        skip("provider-not-installed");
        continue;
      }
      if (provider.availability === "unavailable" || provider.status === "error") {
        skip("provider-unavailable");
        continue;
      }
      if (provider.auth.status !== "authenticated") {
        skip("not-signed-in");
        continue;
      }
      if (
        request.role === "reviewer" &&
        snapshot.manifest.reviewer?.requireDifferentProvider &&
        provider.driver === authorDriver
      ) {
        skip("reviewer-requires-different-provider");
        continue;
      }
      const model = provider.models.find((candidate) => candidate.slug === binding.model);
      const option = model?.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.id === binding.effortOption,
      );
      if (model === undefined) {
        skip("model-unavailable");
        continue;
      }
      if (option?.type !== "select" || !option.options.some((choice) => choice.id === effort)) {
        skip("unsupported-effort");
        continue;
      }
      skip("eligible");
      eligible.push({
        alias,
        provider,
        selection: {
          instanceId: provider.instanceId,
          model: binding.model,
          options: [{ id: binding.effortOption, value: effort }],
        },
      });
    }
  }
  let candidates = eligible;
  if (input.selection !== undefined) {
    const selection = input.selection;
    const requested = eligible.filter(
      ({ selection: value }) =>
        value.model === selection.model &&
        (selection.instanceId === undefined || value.instanceId === selection.instanceId),
    );
    // Explicit choices override preferences, including a reviewer's different-model
    // preference. Role eligibility and authority still apply to every candidate.
    if (requested.length === 0)
      return yield* new AgentRoleError({ reason: "selection-denied", candidates: diagnostics });
    const options = selection.options;
    // A choice may name an eligible model, but cannot inherit hidden or unsupported
    // effort/options. Stated options must be the role's own; omitted ones are the role's.
    const matching =
      options === undefined
        ? requested
        : requested.filter(
            ({ selection: value }) =>
              options.length === value.options?.length &&
              options.every((option) =>
                value.options?.some(
                  (expected) => expected.id === option.id && expected.value === option.value,
                ),
              ),
          );
    if (matching.length === 0)
      return yield* new AgentRoleError({ reason: "unsupported-options", candidates: diagnostics });
    candidates = matching;
  }
  const preference = (alias: string) => {
    const order =
      request.role === "reviewer"
        ? (snapshot.manifest.reviewer?.prefer ?? pool.prefer)
        : pool.prefer;
    const index = order.indexOf(alias);
    return index < 0 ? order.length : index;
  };
  // A pool prefers a model from a different provider than the caller's, so work
  // is checked and advised across providers; its own account earns no preference.
  const callerDriver =
    input.currentInstanceId === undefined
      ? undefined
      : input.providers.find(
          (provider) =>
            provider.instanceId === input.currentInstanceId ||
            provider.poolMembers?.includes(input.currentInstanceId!),
        )?.driver;
  const otherProvider = (candidate: { readonly provider: ServerProvider }) =>
    pool.crossProvider !== false &&
    callerDriver !== undefined &&
    candidate.provider.driver !== callerDriver
      ? 1
      : 0;
  const byUsageReset = compareByUsageReset(DateTime.toEpochMillis(yield* DateTime.now));
  candidates.sort(
    (a, b) =>
      (request.role === "reviewer"
        ? Number(a.selection.model === request.authorModel) -
          Number(b.selection.model === request.authorModel)
        : 0) ||
      otherProvider(b) - otherProvider(a) ||
      preference(a.alias) - preference(b.alias) ||
      byUsageReset(a.provider, b.provider),
  );
  const first = candidates[0];
  if (first === undefined)
    return yield* new AgentRoleError({ reason: "no-eligible-model", candidates: diagnostics });
  return {
    selection: first.selection,
    refusal: null,
    candidates: diagnostics.map((candidate) =>
      candidate.reason !== "eligible"
        ? candidate
        : {
            ...candidate,
            reason:
              candidate.alias === first.alias &&
              candidate.providerInstanceId === first.provider.instanceId
                ? "selected"
                : "lower-preference",
          },
    ),
  };
});

export const layer = Layer.succeed(AgentRoleResolver, {
  resolve: (input) => inspect(input).pipe(Effect.map((result) => result.selection)),
  preview: (input) =>
    inspect(input).pipe(
      Effect.catchTags({
        AgentRoleError: (error) =>
          Effect.succeed({
            selection: null,
            refusal: error.reason,
            candidates: error.candidates ?? [],
          }),
      }),
    ),
});
