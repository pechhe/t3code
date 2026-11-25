import type {
  AccountBlock,
  AgentPolicySnapshot,
  AgentTaskRequest,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  RuntimeMode,
  ServerProvider,
  AgentPolicyPreview,
  RunSetupRouting,
} from "@t3tools/contracts";
import {
  AgentPolicyCandidate,
  isListedOnlyModel,
  isReviewerRole,
  managedExecution,
  usesPhi,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { routingSnapshot, type RoutedCandidate } from "./RoutingDecisions.ts";
import {
  pooledKeyIn,
  pooledModelOfBinding,
  pooledModels,
  rankAccounts,
  standaloneAvailability,
  type AccountAvailability,
  type AccountRoutingSettings,
} from "@t3tools/shared/accountPools";

export class AgentRoleError extends Schema.TaggedError<AgentRoleError>()("AgentRoleError", {
  reason: Schema.Literals([
    "classification",
    "no-eligible-model",
    "selection-denied",
    "unsupported-tools",
    "browser-access-off",
    "phi-disabled",
    "integrated-disabled",
    "phi-skill-missing",
    "phi-unreachable",
    "unsupported-permissions",
    "unsupported-options",
    "source-pin-required",
    "review-scope-required",
    "review-scope-invalid",
    "review-prior-invalid",
    "role-not-configured",
    "usage-limited",
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
  /** Each routed model's accounts; without it every model runs on the account its entry names. */
  readonly routing?: AccountRoutingSettings | undefined;
  /** The server's runtime blocks on accounts, read with usage into each account's state. */
  readonly blocks?: ReadonlyArray<AccountBlock> | undefined;
  /** A task already running is checked for authority only: routing settles its accounts. */
  readonly ignoreAvailability?: boolean | undefined;
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
  /** Ordinary discovery and new launches require an explicit task-fit choice for multi-model roles. */
  readonly requireExplicitSelection?: boolean;
  /**
   * A running trial's assigned model and effort for this task. It replaces the role's list, so a
   * trial can compare what Delegation does not choose today;
   * every account, permission and capability check still applies to it.
   */
  readonly treatment?: ModelSelection;
  /**
   * What the caller found out about the Phi route. A role with the phi tool profile needs it:
   * without a finding it stays refused as unsupported, so no path can start one unchecked.
   */
  readonly browser?: { readonly refusal: BrowserRefusal | null };
};

export type BrowserRefusal =
  | "browser-access-off"
  | "integrated-disabled"
  | "phi-disabled"
  | "phi-skill-missing"
  | "phi-unreachable";

export class AgentRoleResolver extends Context.Service<
  AgentRoleResolver,
  {
    readonly resolve: (input: ResolutionInput) => Effect.Effect<ModelSelection, AgentRoleError>;
    /** `resolve`, with the routing decision behind it as the run's setup record keeps it. */
    readonly decide: (
      input: ResolutionInput,
    ) => Effect.Effect<
      { readonly selection: ModelSelection; readonly routing?: RunSetupRouting },
      AgentRoleError
    >;
    /** The resolution without failing, plus every eligible selection in `resolve`'s order. */
    readonly preview: (
      input: ResolutionInput,
    ) => Effect.Effect<AgentPolicyPreview & { readonly ranked: ReadonlyArray<ModelSelection> }>;
    /** Every eligible selection in the order `resolve` would try them. */
    readonly rank: (
      input: ResolutionInput,
    ) => Effect.Effect<ReadonlyArray<ModelSelection>, AgentRoleError>;
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
  if (role === undefined)
    return yield* new AgentRoleError({
      reason: "role-not-configured",
      detail: `the agent policy does not configure ${request.role}`,
    });
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
      return yield* invalidScope(`review is only for reviewer, not ${request.role}`);
    if (review.scope === "change" && review.includedChanges.length === 0)
      return yield* invalidScope("review.includedChanges must list at least one change");
    if (
      review.scope === "spec" &&
      (review.specRef === undefined || review.specRevision === undefined)
    )
      return yield* invalidScope(
        "review.specRef and review.specRevision are required for a spec review",
      );
    const prior = review.priorReview;
    const recordsPrior = prior?.baseRevision !== undefined;
    // A delta covers exactly the material changes since the earlier report. A record of that
    // report's own change names its base instead; the server proves the two diffs equal.
    if (prior !== undefined && !recordsPrior && prior.sourceRevision !== review.baseRevision)
      return yield* new AgentRoleError({
        reason: "review-prior-invalid",
        detail: `review.priorReview.sourceRevision (${prior.sourceRevision}) must equal review.baseRevision (${review.baseRevision}), the revision the earlier report judged; to record the earlier report's change against another base or source, also set review.priorReview.baseRevision to the base it used`,
      });
    if (
      prior !== undefined &&
      prior.sourceRevision === request.sourceRevision &&
      (!recordsPrior || prior.baseRevision === review.baseRevision)
    )
      return yield* new AgentRoleError({
        reason: "review-prior-invalid",
        detail:
          "review.priorReview.sourceRevision equals the pinned sourceRevision, so there is nothing new to review; omit priorReview for a full review",
      });
  }
  if (request.role === "implementer" && request.browser !== undefined)
    return yield* new AgentRoleError({
      reason: "unsupported-options",
      detail:
        "implementer takes no browser selection: it checks its work with browser_*. Use browser for a managed browser task.",
    });
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
  const admission = managedExecution({ readOnly, requested: request.executionRequirement });
  if (!readOnly && !specLead && input.ceiling === "approval-required")
    return yield* new AgentRoleError({ reason: "unsupported-permissions" });
  const treatment = input.treatment;
  const treatmentAlias =
    treatment === undefined
      ? undefined
      : Object.entries(snapshot.manifest.models).find(
          ([, binding]) => binding.model === treatment.model,
        );
  const list =
    treatment === undefined
      ? (snapshot.manifest.lists[role.list] ?? [])
      : treatmentAlias === undefined
        ? []
        : [
            {
              model: treatmentAlias[0],
              effort: treatment.options
                ?.find((option) => option.id === treatmentAlias[1].effortOption)
                ?.value?.toString(),
            },
          ];
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
  const claudeWriterRefusal = (driverKind: string): string | undefined => {
    if (readOnly || specLead || driverKind !== "claudeAgent") return undefined;
    if (!input.allowTrustedClaudeWriters) return "trusted-claude-disabled";
    if ((input.runtimeMode ?? input.ceiling) !== "full-access")
      return "trusted-claude-requires-full-access";
    if (admission.executionRequirement !== "trusted-host-allowed") return "sandbox-required";
    return undefined;
  };
  const eligible: Array<{
    selection: ModelSelection;
    alias: string;
    provider: ServerProvider;
    /** Its place in its routed model's order: Primary, then Overflow. */
    rank: number;
    availability: AccountAvailability;
  }> = [];
  // Each "eligible" diagnostic names its own entry: accounts of one pooled alias can share an instance.
  const entryOf = new Map<AgentPolicyCandidate, (typeof eligible)[number]>();
  const admit = (verdict: AgentPolicyCandidate, entry: (typeof eligible)[number]) => {
    eligible.push(entry);
    entryOf.set(verdict, entry);
  };
  const REASONING_OPTION_IDS = new Set([
    "reasoningEffort",
    "reasoning_effort",
    "effort",
    "thinking",
    "thought_level",
  ]);
  const findReasoningOption = (descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined) =>
    descriptors?.find(
      (candidate) =>
        candidate.type === "select" &&
        (candidate.role === "reasoning" || REASONING_OPTION_IDS.has(candidate.id)),
    );
  const routing = input.routing ?? {};
  const pools = pooledModels(input.providers, routing);
  const context = {
    blocks: input.blocks ?? [],
    nowMs: DateTime.toEpochMillis(yield* DateTime.now),
  };
  const pooledKeyOf = (provider: ServerProvider, slug: string) => {
    const model = provider.models.find((candidate) => candidate.slug === slug);
    return model === undefined ? undefined : pooledKeyIn(routing, provider, model);
  };
  for (const entry of list) {
    const alias = entry.model;
    const binding = snapshot.manifest.models[alias]!;
    const effort = entry.effort;
    // A routed model runs on any account its route gives it, across providers and Pi credentials.
    const pool = pooledModelOfBinding(pools, routing, binding);
    if (pool !== undefined) {
      const ranked = rankAccounts(pool, context);
      for (const entry of pool.accounts) {
        const provider = entry.provider;
        const skip = (reason: string) => record(alias, entry.model, reason, provider.instanceId);
        if (entry.tier === "off") {
          skip("removed-from-model");
          continue;
        }
        const writerRefusal = claudeWriterRefusal(provider.driver);
        if (writerRefusal !== undefined) {
          skip(writerRefusal);
          continue;
        }
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
        const model = provider.models.find((candidate) => candidate.slug === entry.model)!;
        const descriptors = model.capabilities?.optionDescriptors;
        const reasoningOption =
          (binding.effortOption !== undefined
            ? descriptors?.find(
                (candidate) => candidate.id === binding.effortOption && candidate.type === "select",
              )
            : undefined) ?? findReasoningOption(descriptors);
        if (binding.effortOption !== undefined && effort !== undefined) {
          if (
            reasoningOption?.type !== "select" ||
            !reasoningOption.options.some((choice) => choice.id === effort)
          ) {
            skip("unsupported-effort");
            continue;
          }
        }
        const extras = Object.entries(binding.options ?? {}).filter(([id, value]) =>
          descriptors?.some(
            (candidate) =>
              candidate.id === id &&
              candidate.type === "select" &&
              candidate.options.some((choice) => choice.id === value),
          ),
        );
        const verdict = skip("eligible");
        const options = [
          ...(reasoningOption?.type === "select" && effort !== undefined
            ? [{ id: reasoningOption.id, value: effort }]
            : []),
          ...extras.map(([id, value]) => ({ id, value })),
        ];
        // Every check above is one the ranking also makes, so an admitted account is ranked.
        const rank = ranked.findIndex((candidate) => candidate.entry === entry);
        admit(verdict, {
          alias,
          provider,
          rank,
          availability: ranked[rank]?.availability ?? { state: "available" },
          selection: {
            instanceId: provider.instanceId,
            model: entry.model,
            ...(options.length === 0 ? {} : { options }),
          },
        });
      }
      continue;
    }
    // Writers may use any installed provider; readers require declared enforcement.
    const writerRefusal = claudeWriterRefusal(binding.driverKind);
    if (writerRefusal !== undefined) {
      record(alias, binding.model, writerRefusal);
      continue;
    }
    const providers = input.providers.filter((provider) => provider.driver === binding.driverKind);
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
      const verdict = skip("eligible");
      const options = [
        ...(binding.effortOption === undefined || effort === undefined
          ? []
          : [{ id: binding.effortOption, value: effort }]),
        ...extras.map(([id, value]) => ({ id, value })),
      ];
      admit(verdict, {
        alias,
        provider,
        rank: 0,
        availability: standaloneAvailability(routing, provider, binding.model, context),
        selection: {
          instanceId: provider.instanceId,
          model: binding.model,
          pinned: true,
          ...(options.length === 0 ? {} : { options }),
        },
      });
    }
  }
  const requestedModel = input.selection?.model;
  const offList =
    request.offPolicyReason !== undefined &&
    requestedModel !== undefined &&
    !list.some((entry) => snapshot.manifest.models[entry.model]?.model === requestedModel)
      ? requestedModel
      : undefined;
  if (offList !== undefined && isListedOnlyModel(snapshot.manifest, offList)) {
    record(
      `off-policy:${offList}`,
      offList,
      "listed-only: the policy never uses this model off a list; wait for a listed model instead",
    );
  } else if (offList !== undefined) {
    const alias = `off-policy:${offList}`;
    const statedOptions = input.selection?.options ?? [];
    for (const provider of input.providers) {
      const skip = (reason: string) => record(alias, offList, reason, provider.instanceId);
      const writerRefusal = claudeWriterRefusal(provider.driver);
      if (writerRefusal !== undefined) {
        skip(writerRefusal);
        continue;
      }
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
      const model = provider.models.find((candidate) => candidate.slug === offList);
      if (model === undefined) {
        skip("model-unavailable");
        continue;
      }
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const supportedOptions = statedOptions.filter((option) => {
        const descriptor = descriptors.find((candidate) => candidate.id === option.id);
        if (descriptor === undefined) {
          // Drop options merely echoed from the caller's own thread if this model lacks them.
          return false;
        }
        if (descriptor.type === "select") {
          return descriptor.options.some((choice) => choice.id === option.value);
        }
        if (descriptor.type === "boolean") {
          return typeof option.value === "boolean";
        }
        return true;
      });
      const rejectedOption = statedOptions.find(
        (option) =>
          !supportedOptions.includes(option) &&
          !(
            input.caller?.instanceId === provider.instanceId &&
            input.caller.model === model.slug &&
            input.caller.options?.some((own) => own.id === option.id && own.value === option.value)
          ),
      );
      if (rejectedOption !== undefined) {
        skip("unsupported-options");
        continue;
      }
      const verdict = skip("eligible");
      admit(verdict, {
        alias,
        provider,
        rank: 0,
        availability: standaloneAvailability(routing, provider, model.slug, context),
        selection: {
          instanceId: provider.instanceId,
          model: model.slug,
          pinned: true,
          ...(supportedOptions.length === 0 ? {} : { options: supportedOptions }),
        },
      });
    }
  }
  // One choice per routed model, however many entries or accounts serve it.
  const choices = new Set(
    list.map(({ model: alias }) => {
      const binding = snapshot.manifest.models[alias]!;
      return (
        pooledModelOfBinding(pools, routing, binding)?.key ??
        `${binding.driverKind}:${binding.model}`
      );
    }),
  );
  type Candidate = (typeof eligible)[number];
  const REASON_OF = {
    exhausted: "usage-limited",
    reserved: "reserved",
    cooldown: "cooldown",
  } as const;
  /**
   * What holds an account back: out of usage, at its reserve or cooling down after failures. One
   * held back serves only when it is named; a reserve gives way only to a named account.
   */
  const excluded = new Map<
    Candidate,
    { readonly reason: (typeof REASON_OF)[keyof typeof REASON_OF]; readonly untilMs: number }
  >();
  for (const candidate of eligible) {
    const { availability } = candidate;
    if (availability.state === "available" || input.ignoreAvailability === true) continue;
    excluded.set(candidate, {
      reason: REASON_OF[availability.state],
      untilMs:
        availability.returnsAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(availability.returnsAt),
    });
  }
  const serves = (candidate: Candidate) => !excluded.has(candidate);
  const returnOf = (candidate: Candidate) =>
    excluded.get(candidate)?.untilMs ?? Number.POSITIVE_INFINITY;
  /** The refusal when every account that could serve is out: it names the earliest return. */
  const allOut = (detail: string) => {
    const returns = [...excluded.values()].flatMap((entry) =>
      Number.isFinite(entry.untilMs) ? [entry.untilMs] : [],
    );
    const earliest = returns.length === 0 ? undefined : Math.min(...returns);
    return new AgentRoleError({
      reason: "usage-limited",
      candidates: finalDiagnostics(undefined),
      detail: `${detail}${earliest === undefined ? "" : `; the earliest an account returns is ${DateTime.formatIso(DateTime.makeUnsafe(earliest))}`}`,
    });
  };
  let candidates = eligible.filter(serves);
  if (input.selection !== undefined) {
    const selection = input.selection;
    const named = eligible.filter(({ selection: value, provider }) => {
      if (
        selection.model !== undefined &&
        value.model !== selection.model &&
        pooledKeyOf(provider, value.model) !== selection.model
      ) {
        return false;
      }
      if (selection.instanceId !== undefined && value.instanceId !== selection.instanceId) {
        return false;
      }
      return true;
    });
    // Explicit choices override preferences, including a reviewer's different-model
    // preference. Role eligibility and authority still apply to every candidate.
    if (named.length === 0) {
      const offListHint =
        selection.model !== undefined &&
        request.offPolicyReason === undefined &&
        !diagnostics.some((candidate) => candidate.model === selection.model)
          ? " (pass offPolicyReason only if the user requested this model or every listed model is unavailable)"
          : "";
      return yield* new AgentRoleError({
        reason: "selection-denied",
        candidates: diagnostics,
        detail: `${requestedName(selection)} is not eligible for ${request.role}: ${explain(input, diagnostics, selection.instanceId)}${offListHint}`,
      });
    }
    const available = named.filter(serves);
    // A named account runs whatever holds it back, its reserve included, and is never swapped for
    // another. A named model with every account out is tried on one cooling down, as a cool-down
    // is a guess; a spent or reserved account serves only when named.
    const requested = (
      available.length > 0
        ? available
        : selection.instanceId !== undefined
          ? named
          : named.filter((candidate) => excluded.get(candidate)?.reason === "cooldown")
    ).toSorted((a, b) => (available.length > 0 ? 0 : returnOf(a) - returnOf(b)));
    if (requested.length === 0)
      return yield* allOut(
        `${requestedName(selection)} is held back for ${request.role} and no other account can run ${named[0]!.selection.model} with the same options`,
      );
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
      const shown = requested[0]!.selection;
      const offending = mismatches(shown)
        .map((option) => `${option.id}=${String(option.value)}`)
        .join(", ");
      return yield* new AgentRoleError({
        reason: "unsupported-options",
        candidates: diagnostics,
        detail: `option ${offending} ${mismatches(shown).length === 1 ? "is" : "are"} not part of ${request.role}'s selection of ${shown.model} on ${shown.instanceId}, which is ${optionList(shown)}; omit target.options or state exactly those`,
      });
    }
    candidates = matching;
  }
  // The list order, unless the asking model has its own first choice.
  const callerFirst =
    input.requireExplicitSelection || input.callerModel === undefined
      ? undefined
      : Object.entries(snapshot.manifest.models)
          .filter(([, binding]) => binding.model === input.callerModel)
          .map(([alias]) => role.callers?.[alias])
          .find((alias) => alias !== undefined);
  const position = (alias: string) =>
    alias === callerFirst ? -1 : list.findIndex((entry) => entry.model === alias);
  const otherProvider = (candidate: { readonly provider: ServerProvider }) =>
    reviewer &&
    role.preferOtherAuthorProvider === true &&
    authorDriver !== undefined &&
    candidate.provider.driver !== authorDriver
      ? 1
      : 0;
  // The author may be named by its slug on one account or by its routed model.
  const authorKey =
    request.authorModel === undefined
      ? undefined
      : (input.providers
          .map((provider) => pooledKeyOf(provider, request.authorModel!))
          .find((key) => key !== undefined) ?? request.authorModel);
  const wroteIt = (candidate: Candidate) =>
    request.authorModel !== undefined &&
    (candidate.selection.model === request.authorModel ||
      pooledKeyOf(candidate.provider, candidate.selection.model) === authorKey);
  // Preferences choose between models; the route's rank alone orders one model's accounts.
  const modelOf = (candidate: Candidate) =>
    pooledKeyOf(candidate.provider, candidate.selection.model) ?? candidate.selection.model;
  const byModel = new Map<string, { other: number; position: number }>();
  for (const candidate of candidates) {
    const key = modelOf(candidate);
    const seen = byModel.get(key);
    byModel.set(key, {
      other: Math.max(seen?.other ?? 0, otherProvider(candidate)),
      position: Math.min(seen?.position ?? Number.POSITIVE_INFINITY, position(candidate.alias)),
    });
  }
  const modelRank = (candidate: Candidate) => byModel.get(modelOf(candidate))!;
  candidates.sort(
    (a, b) =>
      // A reviewer never defaults to the model that wrote the work.
      (reviewer ? Number(wroteIt(a)) - Number(wroteIt(b)) : 0) ||
      modelRank(b).other - modelRank(a).other ||
      modelRank(a).position - modelRank(b).position ||
      a.rank - b.rank,
  );
  function finalDiagnostics(chosen: Candidate | undefined) {
    return diagnostics.map((candidate) => {
      if (candidate.reason !== "eligible") return candidate;
      const entry = entryOf.get(candidate);
      const out = entry === undefined ? undefined : excluded.get(entry);
      if (out !== undefined)
        return {
          ...candidate,
          reason: out.reason,
          ...(Number.isFinite(out.untilMs)
            ? { until: DateTime.formatIso(DateTime.makeUnsafe(out.untilMs)) }
            : {}),
        };
      return {
        ...candidate,
        reason: entry !== undefined && entry === chosen ? "selected" : "lower-preference",
      };
    });
  }
  if (input.requireExplicitSelection && input.selection?.model === undefined && choices.size > 1) {
    return yield* new AgentRoleError({
      reason: "selection-denied",
      candidates: finalDiagnostics(undefined).map((candidate) =>
        candidate.reason === "lower-preference" ? { ...candidate, reason: "eligible" } : candidate,
      ),
      detail: `choose a model for ${request.role} based on this task; available models and their notes are listed by agent_roles`,
    });
  }
  const chosen = candidates[0];
  if (chosen === undefined)
    return yield* excluded.size > 0 && eligible.every((candidate) => excluded.has(candidate))
      ? allOut(`every account that can run ${request.role}'s models is held back`)
      : new AgentRoleError({
          reason: "no-eligible-model",
          candidates: diagnostics,
          detail: explain(input, diagnostics),
        });
  // A caller that names the account pins it: the task stays there rather than moving on a limit.
  const pin = (value: ModelSelection): ModelSelection =>
    input.selection?.instanceId === undefined ? value : { ...value, pinned: true };
  const routed = (candidate: Candidate): RoutedCandidate => ({
    provider: candidate.provider,
    model: candidate.selection.model,
    availability: candidate.availability,
  });
  // Built only for `decide`: ranking and previews never pay for the snapshot.
  const routingDecision = () => {
    // The served ones in the order tried, then the ones held back, in route order.
    const ordered = [...candidates, ...eligible.filter((entry) => !candidates.includes(entry))];
    const routedOrdered = ordered.map(routed);
    return routingSnapshot({
      kind: "role-candidates",
      nowMs: context.nowMs,
      role: request.role,
      pinned: input.selection?.instanceId !== undefined,
      modelNamed: input.selection?.model !== undefined || input.treatment !== undefined,
      chosen: routedOrdered[ordered.indexOf(chosen)]!,
      ranked: routedOrdered,
    });
  };
  return {
    selection: pin(chosen.selection),
    routing: routingDecision,
    ranked: candidates.map((candidate) => pin(candidate.selection)),
    executionRequirement: admission.executionRequirement,
    executionBoundary: admission.executionBoundary,
    refusal: null,
    candidates: finalDiagnostics(chosen),
  };
});

export const layer = Layer.succeed(AgentRoleResolver, {
  resolve: Effect.fn("AgentRoleResolver.resolve")((input) =>
    inspect(input).pipe(Effect.map((result) => result.selection)),
  ),
  decide: Effect.fn("AgentRoleResolver.decide")((input) =>
    inspect(input).pipe(
      Effect.flatMap(({ selection, routing }) =>
        // A snapshot that cannot be built never fails the choice it describes.
        Effect.sync(routing).pipe(
          Effect.map((snapshot) => ({ selection, routing: snapshot })),
          Effect.catchCause((cause) =>
            Effect.logDebug("Routing snapshot failed", { cause }).pipe(Effect.as({ selection })),
          ),
        ),
      ),
    ),
  ),
  rank: Effect.fn("AgentRoleResolver.rank")((input) =>
    inspect(input).pipe(Effect.map((result) => result.ranked)),
  ),
  preview: Effect.fn("AgentRoleResolver.preview")((input) =>
    inspect(input).pipe(
      Effect.catchTags({
        AgentRoleError: (error) => {
          const admission = managedExecution({
            readOnly:
              input.request.readOnly === true ||
              input.snapshot.manifest.roles[input.request.role]?.sourceAccess === "read-only",
            requested: input.request.executionRequirement,
          });
          return Effect.succeed({
            selection: null,
            refusal: error.detail === undefined ? error.reason : `${error.reason}: ${error.detail}`,
            candidates: error.candidates ?? [],
            ranked: [],
            executionRequirement: admission.executionRequirement,
            executionBoundary: admission.executionBoundary,
          });
        },
      }),
    ),
  ),
});
