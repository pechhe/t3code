import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
} from "./maintenanceResolver.ts";

const driver = ProviderDriverKind.make("pi");
// The runtime reports its own version (Pi core), unrelated to the wrapper's (Pi-Bolt).
const wrappedProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver,
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
const RESTART_NOTE = "Sessions already running keep the old version until they restart.";

it.effect.each([
  {
    case: "a component behind while the wrapper is current",
    installedVersion: "1.3.0",
    registryLatest: "1.3.0",
    components: [{ name: "pi-blackhole", currentVersion: "0.5.18", latestVersion: "0.5.19" }],
    status: "behind_latest",
    latestVersion: "1.3.0",
    message: `Updates available: pi-blackhole 0.5.18 → 0.5.19. ${RESTART_NOTE}`,
  },
  {
    case: "a component behind with the wrapper's latest unknown",
    installedVersion: "1.3.0",
    registryLatest: null,
    components: [{ name: "pi-blackhole", currentVersion: "0.5.18", latestVersion: "0.5.19" }],
    status: "behind_latest",
    latestVersion: "1.3.0",
    message: `Updates available: pi-blackhole 0.5.18 → 0.5.19. ${RESTART_NOTE}`,
  },
  {
    case: "the wrapper and a component behind",
    installedVersion: "1.2.1",
    registryLatest: "1.3.0",
    components: [{ name: "pi-antigravity", currentVersion: "0.14.0", latestVersion: "0.15.0" }],
    status: "behind_latest",
    latestVersion: "1.3.0",
    message: `Updates available: pi-bolt 1.2.1 → 1.3.0, pi-antigravity 0.14.0 → 0.15.0. ${RESTART_NOTE}`,
  },
  {
    case: "only the wrapper behind",
    installedVersion: "1.3.0",
    registryLatest: "2.0.0",
    components: [],
    status: "behind_latest",
    latestVersion: "2.0.0",
    message: `Updates available: pi-bolt 1.3.0 → 2.0.0. ${RESTART_NOTE}`,
  },
  {
    case: "a component that could not be checked while the wrapper is current",
    installedVersion: "1.3.0",
    registryLatest: "1.3.0",
    components: null,
    status: "unknown",
    latestVersion: "1.3.0",
    message: null,
  },
  {
    case: "the wrapper behind and a component that could not be checked",
    installedVersion: "1.2.1",
    registryLatest: "1.3.0",
    components: null,
    status: "behind_latest",
    latestVersion: "1.3.0",
    message: `Updates available: pi-bolt 1.2.1 → 1.3.0. ${RESTART_NOTE}`,
  },
  {
    case: "a current wrapper whose runtime reports another version",
    installedVersion: "1.3.0",
    registryLatest: "1.3.0",
    components: [],
    status: "current",
    latestVersion: "1.3.0",
    message: null,
  },
])("compares the wrapper's own version and its components: $case", (fixture) =>
  enrichProviderSnapshotWithVersionAdvisory(wrappedProvider, {
    ...makeProviderMaintenanceCapabilities({
      provider: driver,
      packageName: "pi-bolt",
      updateExecutable: "pi-bolt",
      updateArgs: ["update", "--all"],
      updateLockKey: "pi-bolt:/usr/local/bin/pi-bolt",
    }),
    installedVersion: fixture.installedVersion,
    lookupComponentUpdates: Effect.succeed(fixture.components),
  }).pipe(
    Effect.provideServiceEffect(
      ProviderLatestVersions.ProviderLatestVersions,
      ProviderLatestVersions.make([["pi-bolt", fixture.registryLatest]]),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("the seeded cache answers")),
    ),
    Effect.map((provider) => {
      expect(provider.versionAdvisory).toEqual({
        status: fixture.status,
        currentVersion: fixture.installedVersion,
        latestVersion: fixture.latestVersion,
        updateCommand: "pi-bolt update --all",
        canUpdate: true,
        canInstallVersion: false,
        checkedAt: expect.any(String),
        message: fixture.message,
        tracksRuntime: false,
      });
    }),
  ),
);
