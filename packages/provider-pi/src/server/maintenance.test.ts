// @effect-diagnostics nodeBuiltinImport:off -- The fixture writes a real agent directory and Pi-Bolt shim the resolver reads.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";

import {
  isPiBoltCommandPath,
  parsePiBoltVersion,
  PI_MAINTENANCE,
  unversionedNpmPackageName,
} from "./maintenance.ts";

const versionSpawner = (stdout: string, spawned: Array<ReadonlyArray<string>>) =>
  ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    spawned.push(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

const writeFile = (path: string, content: string, mode?: number) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  if (mode !== undefined) NodeFS.chmodSync(path, mode);
};

const piProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: true,
  // Pi-Bolt's bundled Pi core, newer than any Pi-Bolt release number.
  version: "1.5.2",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-22T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it.each([
  ["1.5.2 (Pi-Bolt 1.2.1, linux-x64, JIT off)", "1.2.1"],
  ["1.6.0 (Pi-Bolt v1.3.0-beta.2, darwin-arm64)", "1.3.0-beta.2"],
  ["1.6.0", null],
])("reads Pi-Bolt's own version from %j", (output, version) => {
  expect(parsePiBoltVersion(output)).toBe(version);
});

it.each([
  ["npm:pi-blackhole", "pi-blackhole"],
  ["npm:@scope/pi-tools", "@scope/pi-tools"],
  ["npm:pi-blackhole@0.5.18", null],
  ["npm:@scope/pi-tools@^1", null],
  ["git:github.com/example/pi-tools", null],
  ["/home/me/pi/local", null],
])("offers updates for %j only when it is an unversioned npm source", (source, name) => {
  expect(unversionedNpmPackageName(source)).toBe(name);
});

it.each([
  ["/usr/lib/node_modules/pi-bolt/bin/pi-bolt.exe", true],
  ["/home/me/.pi-bolt/npm/1.2.1/pi-bolt-linux-x64/pi", true],
  ["C:\\Users\\me\\AppData\\npm\\pi-bolt.exe", true],
  ["/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", false],
])("recognises a Pi-Bolt install at %j", (path, expected) => {
  expect(isPiBoltCommandPath(path)).toBe(expected);
});

it.effect(
  "offers Pi-Bolt and its outdated npm packages, updating the instance's agent directory",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(
        NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "pi-bolt-"),
      );
      const binDir = NodePath.join(root, "bin");
      const agentDir = NodePath.join(root, "agent");
      writeFile(NodePath.join(binDir, "pi-bolt"), "#!/bin/sh\n", 0o755);
      writeFile(
        NodePath.join(agentDir, "settings.json"),
        JSON.stringify({
          packages: [
            "npm:pi-blackhole",
            "npm:pi-antigravity",
            "npm:pi-pinned@1.0.0",
            { source: "npm:pi-missing" },
            "/home/me/local-package",
          ],
        }),
      );
      const installed = (name: string, version: string) =>
        writeFile(
          NodePath.join(agentDir, "npm", "node_modules", name, "package.json"),
          JSON.stringify({ name, version }),
        );
      installed("pi-blackhole", "0.5.18");
      installed("pi-antigravity", "0.15.0");
      installed("pi-pinned", "1.0.0");
      const env = { PATH: binDir, PI_CODING_AGENT_DIR: agentDir };
      const spawned: Array<ReadonlyArray<string>> = [];

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(PI_MAINTENANCE, {
        binaryPath: "pi-bolt",
        env,
      }).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          versionSpawner("1.5.2 (Pi-Bolt 1.2.1, linux-x64, JIT off)\n", spawned),
        ),
      );
      expect(spawned).toEqual([["--version"]]);
      expect(capabilities.update).toMatchObject({
        args: ["update", "--all"],
        env: { PI_CODING_AGENT_DIR: agentDir },
      });

      const advisory = yield* enrichProviderSnapshotWithVersionAdvisory(
        piProvider,
        capabilities,
      ).pipe(
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([
            ["pi-bolt", "1.3.0"],
            ["pi-blackhole", "0.5.19"],
            ["pi-antigravity", "0.15.0"],
            ["pi-pinned", "2.0.0"],
          ]),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("the seeded cache answers")),
        ),
        Effect.map((provider) => provider.versionAdvisory),
      );
      expect(advisory).toMatchObject({
        status: "behind_latest",
        currentVersion: "1.2.1",
        latestVersion: "1.3.0",
        canUpdate: true,
        message:
          "Updates available: pi-bolt 1.2.1 → 1.3.0, pi-blackhole 0.5.18 → 0.5.19. Sessions already running keep the old version until they restart.",
      });

      // A package whose registry lookup fails is unchecked, not current.
      const unchecked = yield* enrichProviderSnapshotWithVersionAdvisory(
        piProvider,
        capabilities,
      ).pipe(
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([
            ["pi-bolt", "1.2.1"],
            ["pi-blackhole", null],
            ["pi-antigravity", "0.15.0"],
          ]),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("the seeded cache answers")),
        ),
        Effect.map((provider) => provider.versionAdvisory?.status),
      );
      expect(unchecked).toBe("unknown");

      // An unreadable manifest is unchecked too, unlike a package Pi has not installed yet.
      writeFile(
        NodePath.join(agentDir, "npm", "node_modules", "pi-blackhole", "package.json"),
        "{",
      );
      const unreadable = yield* enrichProviderSnapshotWithVersionAdvisory(
        piProvider,
        capabilities,
      ).pipe(
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([
            ["pi-bolt", "1.2.1"],
            ["pi-blackhole", "0.5.19"],
            ["pi-antigravity", "0.15.0"],
          ]),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("the seeded cache answers")),
        ),
        Effect.map((provider) => provider.versionAdvisory?.status),
      );
      expect(unreadable).toBe("unknown");
      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);
