import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  makeProviderMaintenanceCapabilities,
  type ProviderComponentUpdate,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";

import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstallationGate from "./ProviderInstallationGate.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const encoder = new TextEncoder();

// Pi-Bolt reports Pi's core version; the wrapper's own version is the capabilities'.
const piBoltProvider: ServerProvider = {
  instanceId: PI_INSTANCE_ID,
  driver: PI_DRIVER,
  enabled: true,
  installed: true,
  version: "1.5.2",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-22T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const piBoltCapabilities = (input: {
  readonly installedVersion: () => string;
  readonly components: () => ReadonlyArray<ProviderComponentUpdate> | null;
}): ProviderMaintenanceCapabilities => ({
  ...makeProviderMaintenanceCapabilities({
    provider: PI_DRIVER,
    packageName: "pi-bolt",
    updateExecutable: "pi-bolt",
    updateArgs: ["update", "--all"],
    updateLockKey: "pi-bolt:/usr/local/bin/pi-bolt",
  }),
  installedVersion: input.installedVersion(),
  lookupComponentUpdates: Effect.sync(input.components),
});

const layerSpawner = (onRun: (command: string) => void, exitCode: () => number = () => 0) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      onRun((command as unknown as { readonly command: string }).command);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode())),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("updated")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

/** The npm registry answers with `versions` in turn, then is unavailable. */
const layerRegistryVersions = (versions: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const version = versions.shift();
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          version === undefined
            ? new Response("unavailable", { status: 503 })
            : Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      );
    }),
  );

const makeRunner = (capabilities: () => ProviderMaintenanceCapabilities) =>
  Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([piBoltProvider]);
    const setProviderMaintenanceActionState = (input: {
      readonly instanceId: ProviderInstanceId;
      readonly state: ServerProviderUpdateState | null;
    }) =>
      Ref.updateAndGet(providersRef, (providers) =>
        providers.map((provider) => {
          if (provider.instanceId !== input.instanceId) return provider;
          const { updateState: _updateState, ...rest } = provider;
          return input.state ? { ...rest, updateState: input.state } : rest;
        }),
      );
    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshInstanceUsage: () => Ref.get(providersRef),
      prepareConservation: (rows) => Effect.succeed(rows),
      reloadSecretsAndRefresh: () => Ref.get(providersRef),
      applySecretAndRefresh: () => Ref.get(providersRef),
      refreshAfterUpdate: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      invalidateModelCaches: () => Effect.void,
      refreshModelCatalog: Effect.void,
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.sync(capabilities),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      // Pi's core is rated; a Pi-Bolt release number below its floor must not block the update.
      compatibility: [
        {
          driver: PI_DRIVER,
          t3CodeRange: ">=0.0.0",
          ranges: [
            { range: "<1.4.0", status: "broken" },
            { range: ">=1.4.0", status: "supported" },
          ],
        },
      ],
    };
    return yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
      Effect.provide(
        ProviderMaintenanceRunner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
              Layer.succeed(ModelManifest.ModelManifest, {
                current: Effect.succeed(manifest),
                refresh: Effect.succeed(manifest),
                forceRefresh: Effect.succeed(manifest),
                refreshOnDemand: Effect.succeed(manifest),
                refreshInBackground: Effect.void,
              }),
              ProviderLatestVersions.layer,
              ProviderInstallationGate.layer,
            ),
          ),
        ),
      ),
    );
  });

describe("providerMaintenanceRunner with a Pi-Bolt wrapper", () => {
  it.effect.each([
    {
      case: "brings Pi-Bolt and the package current",
      after: { version: "1.3.0", package: "0.5.19" },
      registry: ["1.3.0", "1.3.0"],
      status: "succeeded",
    },
    {
      case: "leaves a package behind",
      after: { version: "1.3.0", package: "0.5.18" },
      registry: ["1.3.0", "1.3.0"],
      status: "unchanged",
    },
    {
      case: "leaves Pi-Bolt behind",
      after: { version: "1.2.1", package: "0.5.19" },
      registry: ["1.3.0", "1.3.0"],
      status: "unchanged",
    },
    {
      case: "cannot check Pi-Bolt's latest release afterwards",
      after: { version: "1.2.1", package: "0.5.19" },
      registry: ["1.3.0"],
      status: "unchanged",
    },
    {
      case: "cannot check the package afterwards",
      after: { version: "1.3.0", package: "unchecked" },
      registry: ["1.3.0", "1.3.0"],
      status: "unchanged",
    },
  ])("an update that $case ends $status", (fixture) => {
    const installed = { version: "1.2.1", package: "0.5.18" };
    return Effect.gen(function* () {
      const runner = yield* makeRunner(() =>
        piBoltCapabilities({
          installedVersion: () => installed.version,
          components: () =>
            installed.package === "unchecked"
              ? null
              : installed.package === "0.5.19"
                ? []
                : [
                    {
                      name: "pi-blackhole",
                      currentVersion: installed.package,
                      latestVersion: "0.5.19",
                    },
                  ],
        }),
      );
      const result = yield* runner.updateProvider({
        provider: PI_DRIVER,
        instanceId: PI_INSTANCE_ID,
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, fixture.status);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "linux"),
          layerRegistryVersions([...fixture.registry]),
          layerSpawner(() => Object.assign(installed, fixture.after)),
        ),
      ),
    );
  });
  it.effect.each([
    { case: "fails", exitCodes: [1], ran: ["npm"], status: "failed" },
    { case: "succeeds", exitCodes: [0, 0], ran: ["npm", "pi-bolt"], status: "succeeded" },
  ])("runs the package step only after the install $case", (fixture) => {
    const installed = { version: "1.2.1" };
    const ran: Array<string> = [];
    const exitCodes = [...fixture.exitCodes];
    return Effect.gen(function* () {
      const runner = yield* makeRunner(() => ({
        ...piBoltCapabilities({ installedVersion: () => installed.version, components: () => [] }),
        update: {
          command: "npm install -g pi-bolt@latest && pi-bolt update --extensions",
          executable: "npm",
          args: ["install", "-g", "pi-bolt@latest"],
          lockKey: "npm-global:/usr/local",
          followUps: [{ executable: "pi-bolt", args: ["update", "--extensions"] }],
        },
      }));
      const result = yield* runner.updateProvider({
        provider: PI_DRIVER,
        instanceId: PI_INSTANCE_ID,
      });
      assert.deepStrictEqual(ran, fixture.ran);
      assert.strictEqual(result.providers[0]?.updateState?.status, fixture.status);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "linux"),
          layerRegistryVersions(["1.3.0", "1.3.0"]),
          layerSpawner(
            (command) => {
              ran.push(command);
              installed.version = "1.3.0";
            },
            () => exitCodes.shift() ?? 0,
          ),
        ),
      ),
    );
  });
});
