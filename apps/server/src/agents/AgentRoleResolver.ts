import type {
  AgentPolicySnapshot,
  AgentTaskRequest,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
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
  ]),
}) {
  override get message(): string {
    return `Managed agent request refused (${this.reason}).`;
  }
}

type ResolutionInput = {
  readonly snapshot: AgentPolicySnapshot;
  readonly request: AgentTaskRequest;
  /** Already intersected with the project's enabled and caller-authorized accounts. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly ceiling: RuntimeMode;
  readonly currentInstanceId?: ProviderInstanceId;
  readonly selection?: ModelSelection;
};

export class AgentRoleResolver extends Context.Service<
  AgentRoleResolver,
  {
    readonly resolve: (input: ResolutionInput) => Effect.Effect<ModelSelection, AgentRoleError>;
  }
>()("t3/agents/AgentRoleResolver") {}

const resolve = Effect.fn("AgentRoleResolver.resolve")(function* (input: ResolutionInput) {
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
  const candidates: Array<{ selection: ModelSelection; alias: string; provider: ServerProvider }> =
    [];
  for (const alias of allowed) {
    const binding = snapshot.manifest.models[alias];
    const effort = request.demanding ? role.effort[alias]?.demanding : role.effort[alias]?.default;
    if (binding === undefined || effort === undefined) continue;
    // Managed enforcement is implemented only in these adapters. Custom model aliases
    // must still resolve to the advertised literal model; no inherited-model fallback.
    if (binding.driverKind !== "codex" && binding.driverKind !== "claudeAgent") continue;
    if (
      request.taskClass !== "non-ui" &&
      (binding.driverKind === "codex" || /^(gpt-|o[134]-)/i.test(binding.model))
    )
      continue;
    // Claude's existing read-only tool whitelist is enforceable. Its workspaceWrite
    // policy currently maps to permission modes, not an isolated source-write boundary.
    if (!readOnly && binding.driverKind === "claudeAgent") continue;
    for (const provider of input.providers) {
      if (
        // A pool is reached through its members, ranked below.
        provider.poolMembers !== undefined ||
        provider.driver !== binding.driverKind ||
        !provider.enabled ||
        !provider.installed ||
        provider.availability === "unavailable" ||
        provider.status === "error" ||
        provider.status === "disabled" ||
        provider.auth.status !== "authenticated"
      )
        continue;
      const model = provider.models.find((candidate) => candidate.slug === binding.model);
      const option = model?.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.id === binding.effortOption,
      );
      if (option?.type !== "select" || !option.options.some((choice) => choice.id === effort))
        continue;
      candidates.push({
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
  if (input.selection !== undefined) {
    const selection = input.selection;
    const candidate = candidates.find(
      ({ selection: value }) =>
        value.instanceId === selection.instanceId && value.model === selection.model,
    );
    if (candidate === undefined) return yield* new AgentRoleError({ reason: "selection-denied" });
    const options = selection.options ?? [];
    // An experiment may choose an eligible model, but cannot inherit hidden or
    // unsupported effort/options. Deliberate high effort is part of the work request.
    if (
      options.length !== candidate.selection.options?.length ||
      options.some(
        (option) =>
          !candidate.selection.options?.some(
            (expected) => expected.id === option.id && expected.value === option.value,
          ),
      )
    )
      return yield* new AgentRoleError({ reason: "unsupported-options" });
    return candidate.selection;
  }
  const preference = (alias: string) => {
    const index = pool.prefer.indexOf(alias);
    return index < 0 ? pool.prefer.length : index;
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
  if (first === undefined) return yield* new AgentRoleError({ reason: "no-eligible-model" });
  return first.selection;
});

export const layer = Layer.succeed(AgentRoleResolver, { resolve });
