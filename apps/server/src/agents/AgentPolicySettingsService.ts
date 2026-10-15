import {
  AgentPolicySettingsError,
  type AgentPolicySettings,
  type AgentPolicySaveInput,
  type AgentPolicyPreviewInput,
  type AgentPolicyPreview,
  type AgentPolicyManifest,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Policy from "./AgentPolicyService.ts";
import * as Resolver from "./AgentRoleResolver.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Processes from "../processRunner.ts";

export class AgentPolicySettingsService extends Context.Service<
  AgentPolicySettingsService,
  {
    readonly read: () => Effect.Effect<AgentPolicySettings, AgentPolicySettingsError>;
    readonly save: (
      input: AgentPolicySaveInput,
    ) => Effect.Effect<AgentPolicySettings, AgentPolicySettingsError>;
    readonly preview: (
      input: AgentPolicyPreviewInput,
    ) => Effect.Effect<AgentPolicyPreview, AgentPolicySettingsError>;
  }
>()("t3/agents/AgentPolicySettingsService") {}

const make = Effect.gen(function* () {
  const policy = yield* Policy.AgentPolicyService;
  const resolver = yield* Resolver.AgentRoleResolver;
  const providers = yield* Providers.ProviderRegistry;
  const process = yield* Processes.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = Config.String("T3CODE_AGENT_POLICY_ROOT").pipe(
    Effect.mapError((cause) => new AgentPolicySettingsError({ reason: "not-configured", cause })),
  );
  const load = Effect.fn(function* () {
    return yield* policy
      .snapshot(yield* root)
      .pipe(Effect.mapError((cause) => new AgentPolicySettingsError({ reason: "read", cause })));
  });
  const read = Effect.fn("AgentPolicySettingsService.read")(function* () {
    const sourceRoot = yield* root;
    const snapshot = yield* load();
    const jj = yield* fs
      .exists(path.join(sourceRoot, ".jj"))
      .pipe(Effect.mapError((cause) => new AgentPolicySettingsError({ reason: "read", cause })));
    const result = yield* process
      .run({
        command: jj ? "jj" : "git",
        args: jj
          ? ["diff", "--summary", "-r", "@", "--", "roles"]
          : ["status", "--porcelain", "--", "roles"],
        cwd: sourceRoot,
        timeout: "10 seconds",
        maxOutputBytes: 4096,
      })
      .pipe(Effect.option);
    const uncommitted =
      result._tag === "Some" && result.value.code === 0
        ? result.value.stdout.trim().length > 0
        : null;
    return { snapshot, sourceRoot, uncommitted, providers: yield* providers.getProviders };
  });
  const validateModels = Effect.fn(function* (manifest: AgentPolicyManifest) {
    const catalog = yield* providers.getProviders;
    const current = yield* load();
    for (const [alias, binding] of Object.entries(manifest.models)) {
      if (binding.driverKind !== "codex" && binding.driverKind !== "claudeAgent")
        return yield* new AgentPolicySettingsError({ reason: "unsupported-model" });
      const matching = catalog
        .filter(
          (provider) =>
            provider.poolMembers === undefined && provider.driver === binding.driverKind,
        )
        .flatMap((provider) => provider.models.filter((model) => model.slug === binding.model));
      const previous = current.manifest.models[alias];
      // Existing offline declarations remain editable; an unavailable account is not a
      // reason to erase its policy. New bindings must exist in the installed catalog.
      if (
        matching.length === 0 &&
        (previous?.model !== binding.model ||
          previous.driverKind !== binding.driverKind ||
          previous.effortOption !== binding.effortOption)
      )
        return yield* new AgentPolicySettingsError({ reason: "unsupported-model" });
      for (const role of Object.values(manifest.roles)) {
        const effort = role.effort[alias];
        if (effort === undefined) continue;
        const options = matching
          .flatMap((model) => model.capabilities?.optionDescriptors ?? [])
          .filter((option) => option.id === binding.effortOption);
        if (
          matching.length > 0 &&
          [effort.default, effort.demanding].some(
            (value) =>
              value !== undefined &&
              !options.some(
                (option) =>
                  option.type === "select" && option.options.some((choice) => choice.id === value),
              ),
          )
        )
          return yield* new AgentPolicySettingsError({ reason: "unsupported-model" });
      }
    }
  });
  return AgentPolicySettingsService.of({
    read,
    save: Effect.fn("AgentPolicySettingsService.save")(function* (input) {
      yield* validateModels(input.manifest);
      yield* policy.save(yield* root, input).pipe(
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
      return yield* read();
    }),
    preview: Effect.fn("AgentPolicySettingsService.preview")(function* (input) {
      const current = yield* load();
      return yield* resolver.preview({
        snapshot: { ...current, manifest: input.manifest },
        request: {
          role: input.role,
          taskClass: input.taskClass,
          workId: "settings-preview",
          attemptId: "preview",
          workspacePath: yield* root,
          demanding: input.demanding,
          authorModel: input.authorModel,
          ...(input.role === "reviewer"
            ? {
                sourceRevision: "preview-only",
                review: {
                  scope: "change" as const,
                  baseRevision: "preview-base",
                  includedChanges: ["preview-only"],
                  coverage: "complete" as const,
                },
              }
            : {}),
        },
        providers: yield* providers.getProviders,
        ceiling: "full-access",
        ...(input.callerProviderInstanceId === undefined
          ? {}
          : { currentInstanceId: input.callerProviderInstanceId }),
      });
    }),
  });
});

export const layer = Layer.effect(AgentPolicySettingsService, make).pipe(
  Layer.provide(Policy.layer),
  Layer.provide(Resolver.layer),
  Layer.provide(Processes.layer),
);
