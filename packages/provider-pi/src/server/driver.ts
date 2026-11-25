// User-wide ~/.pi/agent state makes continuation identity use default instance grouping.
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageSlot,
  type ServerSettings,
} from "@t3tools/contracts";
import { PiSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { piUsageReader } from "./usage.ts";
import {
  type AntigravityCachedToken,
  probePiUsageSlots,
  retainPriorUsageSlots,
} from "./usageSlots.ts";
import { reconcilePiScopedModels } from "./enabledModels.ts";
import { refreshPiAccountsExtension } from "./accounts.ts";
import { piAgentDirectory } from "./compaction.ts";
import { makePiTextGeneration } from "./textGeneration.ts";
import { PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  enrichPiSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { PI_MAINTENANCE } from "./maintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodePiSettings = Schema.decodeSync(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | Digest.Digest
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const piInstanceModelPreferenceView = (
  settings: ServerSettings,
  instanceId: ProviderInstance["instanceId"],
) => ({
  preferences: settings.providerModelPreferences?.[instanceId],
  favorites: (settings.favorites ?? [])
    .filter((favorite) => favorite.provider === instanceId)
    .map((favorite) => favorite.model),
});

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  usage: piUsageReader,
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: Effect.fn("PiDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const host = yield* ProviderHost.ProviderHost;
    // Pi runs extensions' session_start in its cwd; the server's cwd is $HOME on packaged desktop.
    const probeCwd = pathService.join(host.paths.providerStatusCacheDir, "pi-status-probe");
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    // Before discovery, so a T3 upgrade's account extension is what Pi loads (pi-accounts).
    const accountsAgentDir = piAgentDirectory(processEnv);
    if (accountsAgentDir !== null) {
      yield* refreshPiAccountsExtension(accountsAgentDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.ignoreCause({ log: true }),
      );
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies PiSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(PI_MAINTENANCE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const orchestrationAdapter = yield* PiAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Pi orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makePiTextGeneration(
      effectiveConfig,
      processEnv,
      host.compatibility,
    );

    const lastDiscoveredModelsRef = yield* Ref.make<ReadonlyArray<ServerProviderModel>>([]);
    const syncScopedModelsFromPi = Effect.fn("PiDriver.syncScopedModelsFromPi")(function* (
      snapshot: ServerProvider,
    ) {
      if (!effectiveConfig.enabled || snapshot.auth.status !== "authenticated") {
        return snapshot;
      }
      yield* Ref.set(lastDiscoveredModelsRef, snapshot.models);
      yield* reconcilePiScopedModels({
        instanceId,
        environment: processEnv,
        discoveredModels: snapshot.models,
        getSettings: host.settings.get,
        updateSettings: host.settings.update,
        direction: "from-pi",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.ignoreCause({ log: true }),
      );
      return snapshot;
    });

    const checkProvider = fileSystem
      .makeDirectory(probeCwd, { recursive: true })
      .pipe(
        Effect.ignore,
        Effect.andThen(
          checkPiProviderStatus(effectiveConfig, processEnv, probeCwd, host.compatibility),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

    const antigravityTokenCache = new Map<string, AntigravityCachedToken>();
    const readUsageSlots = probePiUsageSlots({
      environment: processEnv,
      antigravityTokenCache,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    // Pi holds several accounts' credentials, so allowance is read per stored account. A probe
    // answers about allowance only: an unreachable quota host must never fail provider status.
    const lastUsageSlotsRef = yield* Ref.make<ReadonlyArray<ServerProviderUsageSlot>>([]);
    const attachUsageSlots = Effect.fn("PiDriver.attachUsageSlots")(function* (
      snapshot: ServerProvider,
    ) {
      if (!effectiveConfig.enabled) {
        yield* Ref.set(lastUsageSlotsRef, []);
        return snapshot;
      }
      const probed = yield* readUsageSlots.pipe(Effect.catchCause(() => Effect.succeed(null)));
      const usageSlots = yield* Ref.modify(lastUsageSlotsRef, (previous) => {
        const merged = retainPriorUsageSlots(previous, probed);
        return [merged, merged] as const;
      });
      return usageSlots.length === 0 ? snapshot : { ...snapshot, usageSlots };
    });

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkProvider.pipe(
        Effect.flatMap(syncScopedModelsFromPi),
        Effect.flatMap(attachUsageSlots),
      ),
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichPiSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Pi snapshot.",
            cause,
          }),
      ),
    );

    const initialPreferenceView = yield* host.settings.get.pipe(
      Effect.map((current) => piInstanceModelPreferenceView(current, instanceId)),
      Effect.orElseSucceed(() => undefined),
    );
    const settingsChanges = yield* host.settings.subscribe;
    yield* (
      initialPreferenceView === undefined
        ? settingsChanges.pipe(
            Stream.map((current) => piInstanceModelPreferenceView(current, instanceId)),
            Stream.changesWith(Equal.equals),
          )
        : Stream.concat(
            Stream.make(initialPreferenceView),
            settingsChanges.pipe(
              Stream.map((current) => piInstanceModelPreferenceView(current, instanceId)),
            ),
          ).pipe(Stream.changesWith(Equal.equals), Stream.drop(1))
    ).pipe(
      Stream.runForEach(() =>
        Ref.get(lastDiscoveredModelsRef).pipe(
          Effect.flatMap((discoveredModels) =>
            discoveredModels.length === 0
              ? Effect.void
              : reconcilePiScopedModels({
                  instanceId,
                  environment: processEnv,
                  discoveredModels,
                  getSettings: host.settings.get,
                  direction: "to-pi",
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.ignoreCause({ log: true }),
                ),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    // Re-reads every account's allowance alone; a probe that cannot read credentials changes nothing.
    const refreshUsage = Effect.gen(function* () {
      if (!effectiveConfig.enabled) return;
      const probed = yield* readUsageSlots.pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (probed === null) return;
      const usageSlots = yield* Ref.modify(lastUsageSlotsRef, (previous) => {
        const merged = retainPriorUsageSlots(previous, probed);
        return [merged, merged] as const;
      });
      yield* snapshot.replaceUsageSlots?.(usageSlots) ?? Effect.void;
    }).pipe(Effect.ignoreCause({ log: true }));

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.gen(function* () {
              const machineSnapshot = yield* snapshot.getSnapshot;
              // SlipJay housekeeping can delete a workspace a thread still references; that must not fail the registry refresh.
              const workspaceExists = yield* fileSystem
                .exists(workspaceCwd)
                .pipe(Effect.orElseSucceed(() => true));
              if (!workspaceExists) return { ...machineSnapshot, slashCommandsPending: false };
              const commands = yield* discoverPiCommandsForCwd(
                effectiveConfig,
                processEnv,
                workspaceCwd,
              ).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: "Failed to discover Pi workspace commands.",
                      cause,
                    }),
                ),
              );
              return { ...machineSnapshot, ...commands, slashCommandsPending: false };
            }),
      orchestrationAdapter,
      textGeneration,
      refreshUsage,
      piCredentials: { environment: processEnv, binaryPath: effectiveConfig.binaryPath },
    } satisfies ProviderInstance;
  }),
};
