// Fork cases for ProviderRegistry live here; upstream's own cases stay in ProviderRegistry.test.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "./providerStatusCache.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const withBundledCompatibility = (snapshot: ServerProvider) =>
  applyProviderCompatibility(
    snapshot,
    undefined,
    ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
  );

const layerUnusedMutator = Layer.mock(
  ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
)({});

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
).pipe(Layer.provideMerge(ModelManifest.layerTest));

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const layerTestNodeServices = Layer.mergeAll(
  ProviderLatestVersions.layer,
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  NodeCrypto.layer,
  Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
    endpoint: Effect.succeed("unused-private-pipe"),
  }),
  Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "unused-managed-installation",
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
  // An empty home, so the developer's own Claude settings never reach provider probes.
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.gen(function* () {
      return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.layer(
  Layer.mergeAll(layerTestNodeServices, ServerSettingsModule.layerTest(), layerTestHttpClient),
)("ProviderRegistry", (it) => {
  describe("ProviderRegistry.layer", () => {
    it.effect.each([
      "usage",
      "credentials",
      "timeout",
      "during-identity-usage",
      "during-identity-account",
      "during-identity-instance",
    ] as const)(
      "batch conservation uses the final account state after a delayed sibling refresh: %s",
      (change) =>
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("codex");
          const a = ProviderInstanceId.make("batch-A"),
            b = ProviderInstanceId.make("batch-B"),
            c = ProviderInstanceId.make("batch-C");
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const rule = {
            enabled: true,
            remainingPercent: 20,
            window: "session",
            windowIds: ["session"],
            models: ["workspace-model"],
          } as const;
          const row = (
            id: ProviderInstanceId,
            usedPercent: number,
            stale = false,
          ): ServerProvider => ({
            instanceId: id,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated", email: id },
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
            checkedAt,
            usageLimits: {
              checkedAt: stale ? "1969-12-31T23:58:00Z" : checkedAt,
              credentialFingerprint: id,
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent }],
            },
          });
          const snapshots = yield* Ref.make(
            new Map([
              [a, row(a, 10)],
              [b, row(b, 10, true)],
              [c, row(c, 10)],
            ]),
          );
          const aIdentity = yield* Ref.make<string | undefined>(a);
          const startedB = yield* Deferred.make<void>();
          const releaseB = yield* Deferred.make<void>();
          const identityStarted = yield* Deferred.make<void>();
          const releaseIdentity = yield* Deferred.make<void>();
          let identityReads = 0;
          const updates = yield* PubSub.unbounded<ServerProvider>();
          const instances: ProviderInstance[] = [a, b, c].map((id) => ({
            instanceId: id,
            driverKind: driver,
            enabled: true,
            displayName: undefined,
            continuationIdentity: { driverKind: driver, continuationKey: id },
            readUsageIdentity:
              id === a
                ? Effect.gen(function* () {
                    identityReads++;
                    if (change === "timeout" && identityReads > 1) {
                      yield* Deferred.succeed(identityStarted, undefined);
                      return yield* Effect.never;
                    }
                    if (change.startsWith("during-identity") && identityReads > 1) {
                      const current = yield* Ref.get(aIdentity);
                      yield* Deferred.succeed(identityStarted, undefined);
                      yield* Deferred.await(releaseIdentity);
                      return current;
                    }
                    return yield* Ref.get(aIdentity);
                  })
                : Effect.succeed(id),
            refreshUsage:
              id === b
                ? Deferred.succeed(startedB, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseB)),
                    Effect.andThen(
                      Ref.update(snapshots, (rows) => new Map(rows).set(b, row(b, 10))),
                    ),
                  )
                : Effect.void,
            snapshot: {
              getSnapshot: Ref.get(snapshots).pipe(Effect.map((rows) => rows.get(id)!)),
              refresh: Ref.get(snapshots).pipe(Effect.map((rows) => rows.get(id)!)),
              streamChanges: Stream.fromPubSub(updates).pipe(
                Stream.filter((provider) => provider.instanceId === id),
              ),
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: driver,
                    packageName: null,
                  }),
                ),
              applyUsageLimits: () => Effect.void,
              replaceUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          }));
          const instanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded<void>()),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const services = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(instanceRegistry),
              Layer.provideMerge(
                ServerSettingsModule.layerTest({ subagentConservation: { [a]: rule, [b]: rule } }),
              ),
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-batch-conservation-" }),
              ),
              Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const supplied = (yield* registry.getProviders).map((provider) => ({
              ...provider,
              models: [
                {
                  slug: "workspace-model",
                  name: "Workspace model",
                  isCustom: false,
                  capabilities: null,
                },
              ],
            }));
            const pending = yield* registry.prepareConservation(supplied).pipe(Effect.forkChild);
            yield* Deferred.await(startedB);
            const next = yield* Stream.toPull(
              registry.streamChanges.pipe(
                Stream.filter(
                  (rows) =>
                    rows.find((provider) => provider.instanceId === c)?.usageLimits?.windows[0]
                      ?.usedPercent === 100,
                ),
              ),
            );
            const exhausted = row(c, 100);
            yield* Ref.update(snapshots, (rows) => new Map(rows).set(c, exhausted));
            if (change === "credentials") yield* Ref.set(aIdentity, "replacement-A");
            else if (change === "usage") {
              const active = row(a, 90);
              yield* Ref.update(snapshots, (rows) => new Map(rows).set(a, active));
              yield* PubSub.publish(updates, active);
            }
            yield* PubSub.publish(updates, exhausted);
            yield* next;
            yield* Deferred.succeed(releaseB, undefined);
            if (change === "timeout") {
              yield* Deferred.await(identityStarted);
              yield* TestClock.adjust("1 second");
            }
            if (change.startsWith("during-identity")) {
              yield* Deferred.await(identityStarted);
              if (change === "during-identity-instance") {
                instances[0] = {
                  ...instances[0]!,
                  readUsageIdentity: Effect.succeed("replacement-A"),
                };
              } else {
                const updated = row(a, 90);
                const newer =
                  change === "during-identity-account"
                    ? {
                        ...updated,
                        usageLimits: {
                          ...updated.usageLimits!,
                          credentialFingerprint: "replacement-A",
                        },
                      }
                    : updated;
                const published = yield* Stream.toPull(
                  registry.streamChanges.pipe(
                    Stream.filter(
                      (rows) =>
                        rows.find((provider) => provider.instanceId === a)?.usageLimits?.windows[0]
                          ?.usedPercent === 90,
                    ),
                  ),
                );
                yield* Ref.update(snapshots, (rows) => new Map(rows).set(a, newer));
                yield* PubSub.publish(updates, newer);
                yield* published;
              }
              yield* Deferred.succeed(releaseIdentity, undefined);
            }
            const result = yield* Fiber.join(pending);
            assert.equal(
              result.find((provider) => provider.instanceId === a)?.subagentConservation?.state,
              change === "usage" || change === "during-identity-usage" ? "active" : "unknown",
            );
            assert.equal(
              result.find((provider) => provider.instanceId === b)?.subagentConservation?.state,
              "ready",
            );
            assert.equal(
              result.find((provider) => provider.instanceId === c)?.usageLimits?.windows[0]
                ?.usedPercent,
              100,
            );
            for (const provider of result)
              assert.equal(provider.models[0]?.slug, "workspace-model");
          }).pipe(Effect.provide(services));
        }),
    );

    it.effect.each([false, true])(
      "conservation admission validates credentials before using fresh or remembered usage (unsupported: %s)",
      (unsupported) =>
        Effect.gen(function* () {
          const id = ProviderInstanceId.make("identity-admission");
          const driver = ProviderDriverKind.make("codex");
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const rule = {
            enabled: true,
            remainingPercent: 20,
            window: "session",
            windowIds: ["session"],
            models: ["astra"],
          } as const;
          const row = (credentialFingerprint: string, usedPercent: number): ServerProvider => ({
            instanceId: id,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
            checkedAt,
            ...(unsupported
              ? { conservationScope: { providerIds: [], reason: "Unverified model credential." } }
              : {}),
            usageLimits: {
              checkedAt,
              credentialFingerprint,
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent }],
            },
          });
          const snapshot = yield* Ref.make(row("A", 10));
          const identity = yield* Ref.make<string | undefined>("A");
          let reads = 0;
          let identityReads = 0;
          let fail = false;
          let changeDuringRead = false;
          const refreshUsage = Effect.gen(function* () {
            reads++;
            if (fail) return;
            const current = yield* Ref.get(identity);
            yield* Ref.set(snapshot, row(current ?? "unidentified", current === "B" ? 90 : 10));
            if (changeDuringRead) yield* Ref.set(identity, "D");
          });
          const member = (refreshUsage: Effect.Effect<void>): ProviderInstance => ({
            instanceId: id,
            driverKind: driver,
            displayName: undefined,
            enabled: true,
            continuationIdentity: { driverKind: driver, continuationKey: "usage-replaced" },
            snapshot: {
              getSnapshot: Ref.get(snapshot),
              refresh: Ref.get(snapshot),
              streamChanges: Stream.empty,
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: driver,
                    packageName: null,
                  }),
                ),
              applyUsageLimits: () => Effect.void,
              replaceUsageLimits: () => Effect.void,
            },
            refreshUsage,
            readUsageIdentity: Ref.get(identity).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  identityReads++;
                }),
              ),
            ),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const instance = member(refreshUsage);
          const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: () => Effect.succeed(instance),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: PubSub.subscribe(yield* PubSub.unbounded<void>()),
          });
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const services = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(instances),
              Layer.provideMerge(
                ServerSettingsModule.layerTest({ subagentConservation: { [id]: rule } }),
              ),
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-conservation-identity-" }),
              ),
              Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const admission = registry
              .prepareConservation([row("A", 10)])
              .pipe(
                Effect.map((rows) => rows.find((p) => p.instanceId === id)?.subagentConservation),
              );
            if (unsupported) {
              assert.deepEqual((yield* admission)?.models, []);
              assert.equal((yield* admission)?.unavailable, true);
              assert.equal(reads, 0);
              assert.equal(identityReads, 0);
              return;
            }
            assert.equal((yield* admission)?.state, "ready");
            assert.equal(reads, 0);
            yield* Ref.set(identity, "B");
            assert.equal((yield* admission)?.state, "active");
            assert.equal(reads, 1);
            yield* Ref.set(identity, "C");
            assert.equal((yield* admission)?.state, "ready");
            assert.equal(reads, 2);
            // Failure must not transfer C's fresh ready state to E, nor retry E every admission.
            fail = true;
            yield* Ref.set(identity, "E");
            assert.equal((yield* admission)?.state, "unknown");
            assert.equal((yield* admission)?.state, "unknown");
            assert.equal(reads, 3);
            yield* TestClock.adjust("61 seconds");
            assert.equal((yield* admission)?.state, "unknown");
            assert.equal(reads, 4);
            yield* Ref.set(identity, "C");
            assert.equal((yield* admission)?.state, "ready");
            fail = false;
            changeDuringRead = true;
            yield* Ref.set(identity, "F");
            assert.equal((yield* admission)?.state, "unknown");
            yield* Ref.set(identity, undefined);
            assert.equal((yield* admission)?.state, "unknown");
          }).pipe(Effect.provide(services));
        }),
    );

    it.effect("retired usage refreshes cannot overwrite or throttle their replacement", () =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("usage-replaced");
        const driver = ProviderDriverKind.make("codex");
        const oldStarted = yield* Deferred.make<void>();
        const releaseOld = yield* Deferred.make<void>();
        const releaseNew = yield* Deferred.make<void>();
        const newStarted = yield* Deferred.make<void>();
        const newReads = yield* Ref.make(0);
        const changes = yield* PubSub.unbounded<void>();
        const row = (email: string, usedPercent: number): ServerProvider => ({
          instanceId: id,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated", email },
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
          checkedAt: "2026-11-15T03:00:00.000Z",
          usageLimits: {
            checkedAt: "2026-11-15T03:00:00.000Z",
            credentialFingerprint: email,
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent }],
          },
        });
        const oldRow = row("old@example.com", 10);
        const newRow = row("new@example.com", 90);
        const member = (
          provider: ServerProvider,
          refreshUsage: Effect.Effect<void>,
        ): ProviderInstance => ({
          instanceId: id,
          driverKind: driver,
          displayName: undefined,
          enabled: true,
          continuationIdentity: { driverKind: driver, continuationKey: "usage-replaced" },
          snapshot: {
            getSnapshot: Effect.succeed(provider),
            refresh: Effect.succeed(provider),
            streamChanges: Stream.empty,
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driver,
                  packageName: null,
                }),
              ),
            replaceUsageLimits: () => Effect.void,
            applyUsageLimits: () => Effect.void,
          },
          refreshUsage,
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        });
        const old = member(
          oldRow,
          Deferred.succeed(oldStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseOld))),
        );
        const replacement = member(
          newRow,
          Ref.update(newReads, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(newStarted, undefined)),
            Effect.andThen(Deferred.await(releaseNew)),
          ),
        );
        const current = yield* Ref.make(old);
        const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () => Ref.get(current),
          listInstances: Ref.get(current).pipe(Effect.map((instance) => [instance])),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes),
        });
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(instances),
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-replaced-usage-" }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const next = yield* Stream.toPull(
            registry.streamChanges.pipe(
              Stream.filter((rows) =>
                rows.some((provider) => provider.auth.email === "new@example.com"),
              ),
            ),
          );
          const pendingOld = yield* registry.refreshInstanceUsage(id).pipe(Effect.forkChild);
          yield* Deferred.await(oldStarted);
          yield* Ref.set(current, replacement);
          yield* PubSub.publish(changes, undefined);
          yield* next;
          const pendingNew = yield* registry.refreshInstanceUsage(id).pipe(Effect.forkChild);
          yield* Deferred.await(newStarted);
          yield* Deferred.succeed(releaseOld, undefined);
          yield* Fiber.join(pendingOld);
          assert.equal((yield* registry.getProviders)[0]?.auth.email, "new@example.com");
          const config = yield* ServerConfig.ServerConfig;
          const cachePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: id,
          });
          assert.equal((yield* readProviderStatusCache(cachePath))?.auth.email, "new@example.com");
          const joinedNew = yield* registry.refreshInstanceUsage(id).pipe(Effect.forkChild);
          yield* Deferred.succeed(releaseNew, undefined);
          yield* Fiber.join(pendingNew);
          yield* Fiber.join(joinedNew);
          yield* registry.refreshInstanceUsage(id);
          assert.equal(yield* Ref.get(newReads), 1);
        }).pipe(Effect.provide(services));
      }),
    );

    it.effect.each([true, false])(
      "shares one usage refresh per instance and keeps the cache when it times out (instance override: %s)",
      (instanceOverride) =>
        Effect.gen(function* () {
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const cachedProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshes = yield* Ref.make(0);
          const refreshTime = yield* Ref.make(Duration.seconds(1));
          const refreshUsage = Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(Ref.get(refreshTime)),
            Effect.flatMap(Effect.sleep),
          );
          const instance = {
            instanceId: claudeInstanceId,
            driverKind: claudeDriver,
            continuationIdentity: {
              driverKind: claudeDriver,
              continuationKey: "claudeAgent:instance:claudeAgent",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: claudeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("usage refresh must not run the whole probe")),
              refreshUsage,
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
              replaceUsageLimits: () => Effect.void,
            },
            ...(instanceOverride ? { refreshUsage } : {}),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === claudeInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-usage-refresh-",
                }),
              ),
              Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const cached = [withBundledCompatibility(cachedProvider)];

            const concurrent = yield* Effect.all(
              [
                registry.refreshInstanceUsage(claudeInstanceId),
                registry.refreshInstanceUsage(claudeInstanceId),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.forkChild);
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Fiber.join(concurrent);
            assert.strictEqual(yield* Ref.get(refreshes), 1);

            yield* TestClock.adjust(Duration.minutes(1));
            yield* Ref.set(refreshTime, Duration.hours(1));
            const slow = yield* registry
              .refreshInstanceUsage(claudeInstanceId)
              .pipe(Effect.forkChild);
            yield* TestClock.adjust(ProviderRegistry.USAGE_REFRESH_TIMEOUT);
            assert.deepStrictEqual(yield* Fiber.join(slow), cached);
            assert.deepStrictEqual(yield* registry.getProviders, cached);
            assert.strictEqual(yield* Ref.get(refreshes), 2);

            // The timed-out read no longer holds the slot, but it counts as an attempt: calls
            // within the minute start nothing, and the first call after it reads again.
            yield* Ref.set(refreshTime, Duration.zero);
            yield* registry.refreshInstanceUsage(claudeInstanceId);
            assert.strictEqual(yield* Ref.get(refreshes), 2);
            yield* TestClock.adjust(Duration.seconds(50));
            yield* registry.refreshInstanceUsage(claudeInstanceId);
            assert.strictEqual(yield* Ref.get(refreshes), 2);
            yield* TestClock.adjust(Duration.seconds(10));
            yield* registry.refreshInstanceUsage(claudeInstanceId);
            assert.strictEqual(yield* Ref.get(refreshes), 3);

            // A caller interrupted while it waits doesn't strand the read: it finishes, frees
            // the slot, and the next window's call reads again.
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Ref.set(refreshTime, Duration.seconds(1));
            const interrupted = yield* registry
              .refreshInstanceUsage(claudeInstanceId)
              .pipe(Effect.forkChild);
            const waiting = yield* registry
              .refreshInstanceUsage(claudeInstanceId)
              .pipe(Effect.forkChild);
            yield* Fiber.interrupt(interrupted);
            yield* TestClock.adjust(Duration.seconds(1));
            assert.deepStrictEqual(yield* Fiber.join(waiting), cached);
            assert.strictEqual(yield* Ref.get(refreshes), 4);
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Ref.set(refreshTime, Duration.zero);
            yield* registry.refreshInstanceUsage(claudeInstanceId);
            assert.strictEqual(yield* Ref.get(refreshes), 5);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );
  });
});
