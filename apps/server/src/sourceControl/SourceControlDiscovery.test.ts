import {
  SourceControlProviderKind,
  type SourceControlDiscoveryResult,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  fakeDiscovery,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const kind = SourceControlProviderKind.make;

type DiscoveryRun = (
  input: Pick<
    SourceControlHost.SourceControlProcessInput,
    "operation" | "command" | "args" | "cwd"
  >,
) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsError>;

// Serves both the host's runs and the server's own VCS probes, whose inputs share these fields.
const run: DiscoveryRun = (input) => {
  if (input.args[0] === "--version") {
    return input.command === "missing-cli"
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(TestSourceControlHost.processOutput(`${input.command} version test\n`));
  }
  return Effect.succeed(
    TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
  );
};

const cliDiscovery = (name: string) => ({
  type: "cli" as const,
  kind: kind(name),
  label: name,
  installHint: `Install ${name}.`,
  executable: name === "beta" ? "missing-cli" : `${name}-cli`,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: ({ stdout }: { readonly stdout: string }) =>
    providerAuth({ status: "authenticated", account: /as (\S+)/.exec(stdout)?.[1] }),
});

/** A discovery layer whose probes and hosting integrations run commands through `processRun`. */
const layerDiscoveryWith = (processRun: DiscoveryRun) =>
  Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    SourceControlProviderRegistry.makeWithProviders(
      [
        cliDiscovery("alpha"),
        cliDiscovery("beta"),
        fakeDiscovery("gamma", {
          probeAuth: Effect.succeed(providerAuth({ status: "authenticated", account: "api-user" })),
        }),
      ].map((discovery) => ({
        kind: discovery.kind,
        provider: fakeSourceControlProvider(discovery.kind),
        discovery,
      })),
    ),
  ).pipe(
    Layer.provideMerge(TestSourceControlHost.layer({ process: { run: processRun } })),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provideMerge(Layer.mock(VcsProcess.VcsProcess)({ run: processRun })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const layerDiscovery = layerDiscoveryWith(run);

it.effect("reports every hosting integration in registry order with its sign-in", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        version: item.version,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: kind("alpha"),
          status: "available",
          version: Option.some("alpha-cli version test"),
          auth: "authenticated",
          account: Option.some("alpha-cli-user"),
        },
        {
          kind: kind("beta"),
          status: "missing",
          version: Option.none(),
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: kind("gamma"),
          status: "available",
          version: Option.none(),
          auth: "authenticated",
          account: Option.some("api-user"),
        },
      ],
    );
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "available"],
      ],
    );
  }).pipe(Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery)))),
);

// SlipJay lands changes on top of Jujutsu, so discovery notes it on the jj row instead of listing
// it as a system of its own. These probes answer `--version` from the given executables, and a
// command the map omits fails to spawn the way a missing CLI does.
const runInstalled =
  (versions: Readonly<Record<string, string>>): DiscoveryRun =>
  (input) => {
    if (input.args[0] !== "--version") {
      return Effect.succeed(
        TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
      );
    }
    const version = versions[input.command];
    return version === undefined
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(TestSourceControlHost.processOutput(`${version}\n`));
  };

const runWithFailingSlipjay: DiscoveryRun = (input) =>
  input.command === "slipjay" && input.args[0] === "--version"
    ? Effect.fail(
        new VcsProcessExitError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          exitCode: 2,
          detail: "slipjay: cannot read the workspace",
        }),
      )
    : runInstalled({ git: "git version 2.51.0", jj: "jj 0.44.0" })(input);

const discoverWith = (processRun: DiscoveryRun) =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    return yield* discovery.discover;
  }).pipe(
    Effect.provide(
      SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscoveryWith(processRun))),
    ),
  );

/** The rows that mention SlipJay, as the user sees them in Settings. */
const slipjayNotes = (result: SourceControlDiscoveryResult) =>
  result.versionControlSystems
    .flatMap((item) => Option.toArray(item.detail))
    .filter((detail) => detail.includes("SlipJay"));

it.effect("names the SlipJay version on the Jujutsu row when slipjay allocates workspaces", () =>
  Effect.gen(function* () {
    const result = yield* discoverWith(
      runInstalled({ git: "git version 2.51.0", jj: "jj 0.44.0", slipjay: "3.15.0" }),
    );

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status, item.detail]),
      [
        ["git", "available", Option.none()],
        [
          "jj",
          "available",
          Option.some("SlipJay 3.15.0 allocates workspaces for repositories with a slipjay.json."),
        ],
      ],
    );
    assert.deepStrictEqual(slipjayNotes(result), [
      "SlipJay 3.15.0 allocates workspaces for repositories with a slipjay.json.",
    ]);
  }),
);

it.effect("leaves SlipJay off every row when Jujutsu is missing", () =>
  Effect.gen(function* () {
    const result = yield* discoverWith(
      runInstalled({ git: "git version 2.51.0", slipjay: "3.15.0" }),
    );

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "missing"],
      ],
    );
    assert.deepStrictEqual(slipjayNotes(result), []);
  }),
);

it.effect("leaves SlipJay off the Jujutsu row when the slipjay CLI is missing or fails", () =>
  Effect.forEach(
    [runInstalled({ git: "git version 2.51.0", jj: "jj 0.44.0" }), runWithFailingSlipjay],
    (processRun) =>
      Effect.gen(function* () {
        const result = yield* discoverWith(processRun);

        assert.deepStrictEqual(
          result.versionControlSystems.map((item) => [item.kind, item.status, item.version]),
          [
            ["git", "available", Option.some("git version 2.51.0")],
            ["jj", "available", Option.some("jj 0.44.0")],
          ],
        );
        assert.deepStrictEqual(slipjayNotes(result), []);
      }),
    { discard: true },
  ),
);
