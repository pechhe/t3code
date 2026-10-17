import type {
  AgentPolicySnapshot,
  AgentTaskRequest,
  ModelSelection,
  ProviderInstanceId,
  RuntimeMode,
  ServerProvider,
  AgentPolicyPreview,
} from "@t3tools/contracts";
import { AgentPolicyCandidate, isReviewerRole, REVIEWER_SCOPE, usesPhi } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { compareByUsageReset } from "@t3tools/shared/providerPools";

export class AgentRoleError extends Schema.TaggedError<AgentRoleError>()("AgentRoleError", {
  reason: Schema.Literals([
    "classification",
    "no-eligible-model",
    "selection-denied",
    "unsupported-tools",
    "browser-access-off",
    "phi-disabled",
    "phi-skill-missing",
    "phi-unreachable",
    "unsupported-permissions",
    "unsupported-options",
    "source-pin-required",
    "review-scope-required",
    "review-scope-invalid",
    "role-not-configured",
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
  readonly runtimeMode?: RuntimeMode;
  readonly allowTrustedClaudeWriters?: boolean;
  /** The model the asking agent runs, which a role's `callers` exception may key on. */
  readonly callerModel?: string;
  readonly selection?: RequestedModel;
  /**
   * What the caller found out about the Phi route. A role with the phi tool profile needs it:
   * without a finding it stays refused as unsupported, so no path can start one unchecked.
   */
  readonly browser?: { readonly refusal: BrowserRefusal | null };
};

export type BrowserRefusal =
  | "browser-access-off"
  | "phi-disabled"
  | "phi-skill-missing"
  | "phi-unreachable";

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
  if (role === undefined) return yield* new AgentRoleError({ reason: "role-not-configured" });
  if (!role.taskClasses.includes(request.taskClass))
    return yield* new AgentRoleError({ reason: "classification" });
  const reviewer = isReviewerRole(request.role);
  if (reviewer && request.sourceRevision === undefined)
    return yield* new AgentRoleError({ reason: "source-pin-required" });
  const review = request.review;
  if (reviewer && review === undefined)
    return yield* new AgentRoleError({ reason: "review-scope-required" });
  if (
    review !== undefined &&
    (!isReviewerRole(request.role) ||
      review.scope !== REVIEWER_SCOPE[request.role] ||
      (review.scope === "change" && review.includedChanges.length === 0) ||
      (review.scope === "spec" &&
        (review.specRef === undefined || review.specRevision === undefined)) ||
      // A delta covers exactly the material changes since the earlier report.
      (review.priorReview !== undefined &&
        (review.priorReview.sourceRevision !== review.baseRevision ||
          review.priorReview.sourceRevision === request.sourceRevision)))
  )
    return yield* new AgentRoleError({ reason: "review-scope-invalid" });
  // A Phi role browses only over its pinned Phi endpoint, never another browser, so it starts
  // only once the caller has checked that route.
  if (usesPhi(role.toolProfile)) {
    if (input.browser === undefined)
      return yield* new AgentRoleError({ reason: "unsupported-tools" });
    if (input.browser.refusal !== null)
      return yield* new AgentRoleError({ reason: input.browser.refusal });
  }
  const readOnly = role.sourceAccess === "read-only" || request.readOnly === true;
  if (!readOnly && input.ceiling === "approval-required")
    return yield* new AgentRoleError({ reason: "unsupported-permissions" });
  const list = snapshot.manifest.lists[role.list] ?? [];
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
  const large = request.demanding ? role.large : undefined;
  const eligible: Array<{ selection: ModelSelection; alias: string; provider: ServerProvider }> =
    [];
  for (const entry of list) {
    const alias = entry.model;
    const binding = snapshot.manifest.models[alias]!;
    const effort = large?.model === alias ? large.effort : entry.effort;
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
    if (!readOnly && binding.driverKind === "claudeAgent") {
      const refusal = !input.allowTrustedClaudeWriters
        ? "trusted-claude-disabled"
        : (input.runtimeMode ?? input.ceiling) !== "full-access"
          ? "trusted-claude-requires-full-access"
          : request.executionRequirement !== "trusted-host-allowed"
            ? "sandbox-required"
            : undefined;
      if (refusal !== undefined) {
        record(alias, binding.model, refusal);
        continue;
      }
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
      // A model that does not offer a policy option (say fast, on an account without it)
      // still runs; it just starts without that option.
      const extras = Object.entries(binding.options ?? {}).filter(([id, value]) =>
        model?.capabilities?.optionDescriptors?.some(
          (candidate) =>
            candidate.id === id &&
            candidate.type === "select" &&
            candidate.options.some((choice) => choice.id === value),
        ),
      );
      skip("eligible");
      eligible.push({
        alias,
        provider,
        selection: {
          instanceId: provider.instanceId,
          model: binding.model,
          options: [
            { id: binding.effortOption, value: effort },
            ...extras.map(([id, value]) => ({ id, value })),
          ],
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
  // The list order, unless the task is large or the asking model has its own first choice.
  const callerFirst =
    input.callerModel === undefined
      ? undefined
      : Object.entries(snapshot.manifest.models)
          .filter(([, binding]) => binding.model === input.callerModel)
          .map(([alias]) => role.callers?.[alias])
          .find((alias) => alias !== undefined);
  const first = large?.model ?? callerFirst;
  const position = (alias: string) =>
    alias === first ? -1 : list.findIndex((entry) => entry.model === alias);
  const otherProvider = (candidate: { readonly provider: ServerProvider }) =>
    reviewer &&
    role.preferOtherAuthorProvider === true &&
    authorDriver !== undefined &&
    candidate.provider.driver !== authorDriver
      ? 1
      : 0;
  const byUsageReset = compareByUsageReset(DateTime.toEpochMillis(yield* DateTime.now));
  candidates.sort(
    (a, b) =>
      // A reviewer never defaults to the model that wrote the work.
      (reviewer
        ? Number(a.selection.model === request.authorModel) -
          Number(b.selection.model === request.authorModel)
        : 0) ||
      otherProvider(b) - otherProvider(a) ||
      position(a.alias) - position(b.alias) ||
      byUsageReset(a.provider, b.provider),
  );
  const chosen = candidates[0];
  if (chosen === undefined)
    return yield* new AgentRoleError({ reason: "no-eligible-model", candidates: diagnostics });
  return {
    selection: chosen.selection,
    executionRequirement: readOnly
      ? "sandbox-required"
      : (request.executionRequirement ?? "sandbox-required"),
    executionBoundary: readOnly
      ? ("read-only" as const)
      : chosen.provider.driver === "claudeAgent"
        ? ("trusted-host-access" as const)
        : ("workspace-sandbox" as const),
    refusal: null,
    candidates: diagnostics.map((candidate) =>
      candidate.reason !== "eligible"
        ? candidate
        : {
            ...candidate,
            reason:
              candidate.alias === chosen.alias &&
              candidate.providerInstanceId === chosen.provider.instanceId
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
