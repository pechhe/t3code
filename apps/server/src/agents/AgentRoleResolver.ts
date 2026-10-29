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

import { compareByUsageReset, isProviderUsageExhausted } from "@t3tools/shared/providerPools";

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
    "review-prior-invalid",
    "role-not-configured",
  ]),
  candidates: Schema.optional(Schema.Array(AgentPolicyCandidate)),
  /** The offending field, option or account and how to correct the request. */
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Managed agent request refused (${this.reason}${this.detail === undefined ? "" : `: ${this.detail}`}).`;
  }
}

/**
 * A model a caller or experiment asks for within a role. Without an instance, any eligible
 * account offering the model may serve it; without options, the role's own effort applies.
 */
export type RequestedModel = {
  readonly instanceId?: ProviderInstanceId;
  /** Absent when the caller states only options, which the role's own selection must match. */
  readonly model?: string;
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
  /**
   * The account, model and options the asking agent itself runs with. A caller that echoes its
   * options back for that same account and model is not choosing them, so those the role does
   * not set are dropped, never refused.
   */
  readonly caller?: ModelSelection;
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

const requestedName = (selection: RequestedModel) =>
  [selection.model, selection.instanceId === undefined ? undefined : `on ${selection.instanceId}`]
    .filter((part) => part !== undefined)
    .join(" ") || "the requested selection";

const optionList = (selection: ModelSelection) =>
  (selection.options ?? []).map((option) => `${option.id}=${String(option.value)}`).join(", ") ||
  "no options";

/** What currently rules each account and model out, so a changed state names itself. */
const explain = (
  input: ResolutionInput,
  diagnostics: ReadonlyArray<AgentPolicyCandidate>,
  instanceId?: ProviderInstanceId,
) => {
  const lines = [
    ...(instanceId !== undefined && !input.providers.some((p) => p.instanceId === instanceId)
      ? [
          `provider instance ${instanceId} is not available to this project (not installed, disabled or not enabled for it)`,
        ]
      : []),
    ...diagnostics.map(
      (candidate) =>
        `${candidate.model}${candidate.providerInstanceId === undefined ? "" : ` on ${candidate.providerInstanceId}`}: ${candidate.reason}`,
    ),
  ];
  return lines.join("; ");
};

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
  if (review !== undefined) {
    const invalidScope = (detail: string) =>
      new AgentRoleError({ reason: "review-scope-invalid", detail });
    if (!isReviewerRole(request.role))
      return yield* invalidScope(
        `review is only for ticket-reviewer and spec-reviewer, not ${request.role}`,
      );
    if (review.scope !== REVIEWER_SCOPE[request.role])
      return yield* invalidScope(
        `review.scope "${review.scope}" is not valid for ${request.role}; use "${REVIEWER_SCOPE[request.role]}"`,
      );
    if (review.scope === "change" && review.includedChanges.length === 0)
      return yield* invalidScope("review.includedChanges must list at least one change");
    if (
      review.scope === "spec" &&
      (review.specRef === undefined || review.specRevision === undefined)
    )
      return yield* invalidScope(
        "review.specRef and review.specRevision are required for a spec review",
      );
    // A delta covers exactly the material changes since the earlier report.
    const prior = review.priorReview;
    if (prior !== undefined && prior.sourceRevision !== review.baseRevision)
      return yield* new AgentRoleError({
        reason: "review-prior-invalid",
        detail: `review.priorReview.sourceRevision (${prior.sourceRevision}) must equal review.baseRevision (${review.baseRevision}), the revision the earlier report judged`,
      });
    if (prior !== undefined && prior.sourceRevision === request.sourceRevision)
      return yield* new AgentRoleError({
        reason: "review-prior-invalid",
        detail:
          "review.priorReview.sourceRevision equals the pinned sourceRevision, so there is nothing new to review; omit priorReview for a full review",
      });
  }
  // A Phi role browses only over its pinned Phi endpoint, never another browser, so it starts
  // only once the caller has checked that route.
  if (usesPhi(role.toolProfile)) {
    if (input.browser === undefined)
      return yield* new AgentRoleError({ reason: "unsupported-tools" });
    if (input.browser.refusal !== null)
      return yield* new AgentRoleError({ reason: input.browser.refusal });
  }
  // A Spec lead has a top-level thread's permissions: no narrower boundary, and none of the
  // leaf-writer gates below; the caller's ceiling and the role's model list still bind it.
  const specLead = request.role === "lead";
  if (
    specLead &&
    (request.readOnly === true || request.executionRequirement === "sandbox-required")
  )
    return yield* new AgentRoleError({
      reason: "unsupported-permissions",
      detail:
        "a lead runs with a top-level thread's permissions, so it cannot be read-only or sandboxed",
    });
  const readOnly = role.sourceAccess === "read-only" || request.readOnly === true;
  if (!readOnly && !specLead && input.ceiling === "approval-required")
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
    // Writers may use any installed provider; readers require declared enforcement.
    if (!readOnly && !specLead && binding.driverKind === "claudeAgent") {
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
      if (readOnly && provider.readOnlySourceAccess !== "enforced") {
        skip("read-only-unenforced");
        continue;
      }
      if (role.toolProfile === "web-research" && provider.supportsWebResearch !== true) {
        skip("web-research-unsupported");
        continue;
      }
      const model = provider.models.find((candidate) => candidate.slug === binding.model);
      if (model === undefined) {
        skip("model-unavailable");
        continue;
      }
      if (binding.effortOption !== undefined) {
        const option = model.capabilities?.optionDescriptors?.find(
          (candidate) => candidate.id === binding.effortOption,
        );
        if (option?.type !== "select" || !option.options.some((choice) => choice.id === effort)) {
          skip("unsupported-effort");
          continue;
        }
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
      const options = [
        ...(binding.effortOption === undefined || effort === undefined
          ? []
          : [{ id: binding.effortOption, value: effort }]),
        ...extras.map(([id, value]) => ({ id, value })),
      ];
      eligible.push({
        alias,
        provider,
        selection: {
          instanceId: provider.instanceId,
          model: binding.model,
          ...(options.length === 0 ? {} : { options }),
        },
      });
    }
  }
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  let candidates = eligible;
  if (input.selection !== undefined) {
    const selection = input.selection;
    const requested = eligible.filter(
      ({ selection: value }) =>
        (selection.model === undefined || value.model === selection.model) &&
        (selection.instanceId === undefined || value.instanceId === selection.instanceId),
    );
    // Explicit choices override preferences, including a reviewer's different-model
    // preference. Role eligibility and authority still apply to every candidate.
    if (requested.length === 0)
      return yield* new AgentRoleError({
        reason: "selection-denied",
        candidates: diagnostics,
        detail: `${requestedName(selection)} is not eligible for ${request.role}: ${explain(input, diagnostics, selection.instanceId)}`,
      });
    // A choice may name an eligible model, but cannot pick effort or options the role does not
    // set. Stated options must be the role's own; omitted ones are the role's. An option the
    // caller merely inherited (its own id and value, on the same account and model) and the
    // role does not set is dropped, so echoing `fastMode=false` back is harmless.
    const mismatches = (value: ModelSelection) =>
      (selection.options ?? []).filter(
        (option) =>
          !value.options?.some(
            (expected) => expected.id === option.id && expected.value === option.value,
          ) &&
          !(
            input.caller?.instanceId === value.instanceId &&
            input.caller.model === value.model &&
            input.caller.options?.some(
              (own) => own.id === option.id && own.value === option.value,
            ) &&
            !value.options?.some((expected) => expected.id === option.id)
          ),
      );
    const matching = requested.filter(({ selection: value }) => mismatches(value).length === 0);
    if (matching.length === 0) {
      // Name the account that would otherwise serve, not one that is out of allowance.
      const named =
        requested.find(({ provider }) => !isProviderUsageExhausted(provider, nowMs))?.selection ??
        requested[0]!.selection;
      const offending = mismatches(named)
        .map((option) => `${option.id}=${String(option.value)}`)
        .join(", ");
      return yield* new AgentRoleError({
        reason: "unsupported-options",
        candidates: diagnostics,
        detail: `option ${offending} ${mismatches(named).length === 1 ? "is" : "are"} not part of ${request.role}'s selection of ${named.model} on ${named.instanceId}, which is ${optionList(named)}; omit target.options or state exactly those`,
      });
    }
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
  const byUsageReset = compareByUsageReset(nowMs);
  const limitedInstances = new Set(
    eligible
      .filter(({ provider }) => isProviderUsageExhausted(provider, nowMs))
      .map(({ provider }) => provider.instanceId),
  );
  const limited = (candidate: { readonly provider: ServerProvider }) =>
    limitedInstances.has(candidate.provider.instanceId);
  candidates.sort(
    (a, b) =>
      // An account out of allowance serves only when every candidate is, so the work moves
      // down the list instead of failing at once; then the soonest reset serves first.
      (limited(a) || limited(b) ? byUsageReset(a.provider, b.provider) : 0) ||
      // Among accounts with allowance, a reviewer never defaults to the model that wrote the work.
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
    return yield* new AgentRoleError({
      reason: "no-eligible-model",
      candidates: diagnostics,
      detail: explain(input, diagnostics),
    });
  return {
    selection: chosen.selection,
    executionRequirement: readOnly
      ? "sandbox-required"
      : (request.executionRequirement ?? "sandbox-required"),
    executionBoundary: readOnly
      ? ("read-only" as const)
      : specLead || chosen.provider.driver === "claudeAgent"
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
                : candidate.providerInstanceId !== undefined &&
                    limitedInstances.has(candidate.providerInstanceId)
                  ? "usage-limited"
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
            refusal: error.detail === undefined ? error.reason : `${error.reason}: ${error.detail}`,
            candidates: error.candidates ?? [],
          }),
      }),
    ),
});
