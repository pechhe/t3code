import {
  AgentPolicySettingsError,
  type AgentPolicySettings,
  type AgentPolicySaveInput,
  type AgentPolicyManifest,
  type ModelPoolConfig,
  type ModelPoolId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";
import { agentPolicyRoot } from "./agentPolicyRoot.ts";
import * as Policy from "./AgentPolicyService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Processes from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Option from "effect/Option";

export class AgentPolicySettingsService extends Context.Service<
  AgentPolicySettingsService,
  {
    readonly read: () => Effect.Effect<AgentPolicySettings, AgentPolicySettingsError>;
    readonly save: (
      input: AgentPolicySaveInput,
    ) => Effect.Effect<AgentPolicySettings, AgentPolicySettingsError>;
  }
>()("t3/agents/AgentPolicySettingsService") {}

const make = Effect.gen(function* () {
  const policy = yield* Policy.AgentPolicyService;
  const providers = yield* Providers.ProviderRegistry;
  const process = yield* Processes.ProcessRunner;
  const root = agentPolicyRoot.pipe(
    Effect.flatMap((root) =>
      Effect.fromOption(
        root,
        () =>
          new AgentPolicySettingsError({
            reason: "not-configured",
            cause: "T3CODE_AGENT_POLICY_ROOT is not set",
          }),
      ),
    ),
  );
  const load = Effect.fn(function* () {
    return yield* policy
      .snapshot(yield* root)
      .pipe(Effect.mapError((cause) => new AgentPolicySettingsError({ reason: "read", cause })));
  });
  const read = Effect.fn("AgentPolicySettingsService.read")(function* () {
    const sourceRoot = yield* root;
    const snapshot = yield* load();
    const result = yield* process
      .run({
        command: "git",
        args: ["--no-optional-locks", "status", "--porcelain", "--", "roles"],
        cwd: sourceRoot,
        timeout: "10 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.option);
    const uncommitted =
      result._tag === "Some" && result.value.code === 0
        ? result.value.stdout.trim().length > 0
        : null;
    const checkout = yield* AgentConfigCheckout.read(sourceRoot).pipe(
      Effect.provideService(Processes.ProcessRunner, process),
    );
    return {
      snapshot,
      sourceRoot,
      uncommitted,
      checkout: {
        revision: checkout.revision,
        hasLocalChanges: checkout.hasLocalChanges,
        behindMain: yield* AgentConfigCheckout.commitsBehindMain(sourceRoot).pipe(
          Effect.provideService(Processes.ProcessRunner, process),
        ),
      },
      providers: yield* providers.getProviders,
    };
  });
  const validateModels = Effect.fn(function* (manifest: AgentPolicyManifest) {
    const catalog = yield* providers.getProviders;
    const current = yield* load();
    const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const noPools: Readonly<Record<ModelPoolId, ModelPoolConfig>> = {};
    const modelPools = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(
          Effect.map((s) => s.modelPools),
          Effect.orElseSucceed(() => noPools),
        )
      : noPools;
    for (const [alias, binding] of Object.entries(manifest.models)) {
      const pool = binding.poolId === undefined ? undefined : modelPools[binding.poolId];
      const matching =
        pool !== undefined
          ? pool.slots.flatMap((slot) =>
              catalog
                .filter(
                  (provider) =>
                    provider.poolMembers === undefined &&
                    provider.instanceId === slot.providerInstanceId,
                )
                .flatMap((provider) =>
                  provider.models.filter((model) => model.slug === slot.model),
                ),
            )
          : catalog
              .filter(
                (provider) =>
                  provider.poolMembers === undefined && provider.driver === binding.driverKind,
              )
              .flatMap((provider) =>
                provider.models.filter((model) => model.slug === binding.model),
              );
      const previous = current.manifest.models[alias];
      // Existing offline declarations remain editable; an unavailable account is not a
      // reason to erase its policy. New bindings must exist in the installed catalog.
      if (
        matching.length === 0 &&
        (previous?.model !== binding.model ||
          previous.driverKind !== binding.driverKind ||
          previous.poolId !== binding.poolId ||
          previous.effortOption !== binding.effortOption)
      )
        return yield* new AgentPolicySettingsError({ reason: "unsupported-model" });
      // A model without an effort setting runs as its account configures it.
      if (binding.effortOption === undefined) continue;
      const option = binding.effortOption;
      const options = matching
        .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
        .filter(
          (candidate) =>
            candidate.id === option ||
            (pool !== undefined && candidate.type === "select" && candidate.role === "reasoning"),
        );
      const efforts = Object.values(manifest.lists)
        .flat()
        .filter((entry) => entry.model === alias)
        .map((entry) => entry.effort);
      if (
        matching.length > 0 &&
        (efforts.includes(undefined) ||
          efforts.some(
            (value) =>
              !options.some(
                (candidate) =>
                  candidate.type === "select" &&
                  candidate.options.some((choice) => choice.id === value),
              ),
          ))
      )
        return yield* new AgentPolicySettingsError({ reason: "unsupported-model" });
    }
  });
  return AgentPolicySettingsService.of({
    read,
    save: Effect.fn("AgentPolicySettingsService.save")(function* (input) {
      if (input.validateCatalog !== false) yield* validateModels(input.manifest);
      const saved = yield* policy.save(yield* root, input).pipe(
        Effect.mapError(
          (error) =>
            new AgentPolicySettingsError({
              cause: error,
              reason:
                error.reason === "busy"
                  ? "busy"
                  : error.reason === "stale"
                    ? "stale"
                    : error.reason === "invalid" || error.reason === "too-large"
                      ? "invalid"
                      : "write",
            }),
        ),
      );
      // Only a save reports whether the file also reached the shared checkout's remote.
      return { ...(yield* read()), publish: saved.publish };
    }),
  });
});

export const layer = Layer.effect(AgentPolicySettingsService, make).pipe(
  Layer.provide(Policy.layer),
  Layer.provide(Processes.layer),
);
