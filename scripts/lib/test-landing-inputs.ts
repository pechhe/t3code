// What the import graph cannot see between workspaces and tests; see the landing gate in
// scripts/test-landing.ts. test-landing.test.ts fails when either table falls behind the code.

/**
 * Workspace edges the manifests do not declare: one imports the other by relative path.
 * test-landing.test.ts fails on a new undeclared edge.
 */
export const EXTRA_EDGES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["apps/mobile", "scripts"],
  ["apps/server", "scripts"],
  ["oxlint-plugin-t3code", "packages/client-runtime"],
  ["oxlint-plugin-t3code", "packages/shared"],
  ["packages/provider-pi", "packages/client-runtime"],
];

/**
 * Manifest dependencies the code never imports (the server bundles the built web app), so a
 * change in `to` reaches no test in `from`. test-landing.test.ts fails if `from` starts importing it.
 */
export const BUILD_ONLY_EDGES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["apps/server", "apps/web"],
];

export interface InputRule {
  readonly when: RegExp;
  /** Tests, or the modules the import graph leads to them from, that read what `when` matches. */
  readonly select?: ReadonlyArray<string>;
  /** Workspaces whose complete suite reads what `when` matches. */
  readonly workspaces?: ReadonlyArray<string>;
  readonly reason: string;
}

const serverTest = (...names: ReadonlyArray<string>) =>
  names.map((name) => `apps/server/src/${name}`);
// Tests that spawn `apps/server/src/bin.ts`, or a fixture that imports server and package source.
// The spawned program's imports are invisible to the importing test's graph.
const SOURCE_SPAWNERS = [
  ...serverTest(
    "claudeHistoryWorker.test.ts",
    "cli/sshHelper.test.ts",
    "compileCache.test.ts",
    "git/detachStackFrame.memory.test.ts",
    "orchestration-v2/ProviderTurnStartService.memory.test.ts",
    "rpcInitialItems.memory.test.ts",
    "preview/DesktopBrowserChannel.test.ts",
  ),
  "packages/shared/src/observability.memory.test.ts",
  "packages/provider-cursor/src/server/CursorSdk.test.ts",
];
const FIXTURE_DIRECTORY_READERS = serverTest(
  "provider/ProviderInstanceRegistry.test.ts",
  "provider/ClaudeCapabilitiesProbe.test.ts",
  "textGeneration/GrokTextGeneration.test.ts",
  "textGeneration/ClaudeTextGeneration.test.ts",
  "vcs/GitVcsDriverCore.test.ts",
);
const REPLAY_TRANSCRIPT_READERS = [
  "apps/server/src/orchestration-v2/testkit/fixtures/index.ts",
  ...serverTest(
    "mcp/OrchestratorMcpToolkit.integration.test.ts",
    "orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts",
    "orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts",
    "orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts",
    "orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts",
    "orchestration-v2/testkit/ThreadFork.integration.test.ts",
    "orchestration-v2/testkit/ThreadMergeBack.integration.test.ts",
    "provider/OpenCode2Client.events.test.ts",
  ),
];
const ACP_AGENT_SPAWNERS = [
  // The testkits spawn acp-replay-agent.ts; the tests that import them are found from here.
  ...serverTest(
    "orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts",
    "orchestration-v2/Adapters/GrokAdapterV2.testkit.ts",
    "orchestration-v2/Adapters/AcpAdapterV2.test.ts",
    "orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts",
    "orchestration-v2/Adapters/AntigravityAdapterV2.test.ts",
    "orchestration-v2/Adapters/GrokAdapterV2.test.ts",
    "provider/AcpRegistryProbe.test.ts",
    "provider/Drivers/AntigravityDriver.test.ts",
    "provider/GrokProvider.test.ts",
    "provider/acp/AcpJsonRpcConnection.test.ts",
    "provider/acp/AcpSessionRuntime.processTree.test.ts",
  ),
];

export const INPUT_RULES: ReadonlyArray<InputRule> = [
  {
    when: /^(?:apps\/server\/(?:src|scripts)\/|packages\/[^/]+\/src\/)/,
    select: SOURCE_SPAWNERS,
    reason: "source spawned in a child process",
  },
  {
    when: /^apps\/server\/scripts\//,
    select: ACP_AGENT_SPAWNERS,
    reason: "ACP mock and replay agents spawned in a child process",
  },
  {
    when: /^apps\/server\/src\/orchestration-v2\/testkit\/fixtures\//,
    select: REPLAY_TRANSCRIPT_READERS,
    reason: "replay transcripts read from disk",
  },
  {
    when: /^apps\/server\/src\/(?:provider|textGeneration|vcs|git|preview)\/(?:testing|testFixtures)\//,
    select: FIXTURE_DIRECTORY_READERS,
    reason: "fixture programs spawned from disk",
  },
  {
    when: /^apps\/server\/src\//,
    select: serverTest("orchestration-v2/V1ImportBoundary.test.ts"),
    reason: "test reads every production source file",
  },
  {
    when: /^\.github\/triage\//,
    select: serverTest("cli/triagePrompt.test.ts"),
    reason: "the bundled playbook must equal the repository copy",
  },
  {
    when: /^fork\/shipped-client\//,
    select: serverTest("shippedClientCompatibility.test.ts"),
    reason: "test reads the shipped client's settings schema",
  },
  {
    when: /^\.github\/workflows\/release\.yml$/,
    select: ["scripts/notify-discord-release.test.ts"],
    reason: "test reads the release workflow",
  },
  {
    when: /^apps\/server\/src\/device\/deviceToolVersions\.json$|^third-party-licenses\.config\.json$|^apps\/mobile\/modules\/t3-terminal\/Vendor\/libghostty\/VERSION$/,
    select: ["scripts/lib/third-party-licenses.test.ts"],
    reason: "test reads the license inputs from disk",
  },
  {
    when: /^scripts\/npm-launcher\//,
    select: ["scripts/build-npm-launcher.test.ts"],
    reason: "launcher files are copied and run by the test",
  },
  {
    when: /^scripts\/install\.sh$/,
    select: ["scripts/install.test.ts"],
    reason: "test runs the installer",
  },
  {
    when: /^scripts\/fork-(?:nightly|reconcile-fixtures)\.sh$/,
    select: ["scripts/fork-nightly.test.ts"],
    reason: "test runs the script",
  },
  {
    when: /^apps\/mobile\/(?:plugins\/|app\.config\.ts$)/,
    select: ["apps/mobile/plugins/withAndroidFbjniVersion.test.mjs"],
    reason: "test applies the registered app config and plugins",
  },
  {
    when: /^scripts\/fork-vps-runtime\.sh$/,
    select: ["scripts/fork-vps-runtime.test.ts"],
    reason: "test runs the script",
  },
  {
    when: /^scripts\/knip-schemas\.ts$/,
    select: ["scripts/knip-schemas.test.ts"],
    reason: "test runs knip with the preprocessor",
  },
  {
    when: /^(?:scripts\/lib\/cursor-sdk|packages\/provider-cursor\/)/,
    select: ["scripts/lib/cursor-sdk-packaging.test.ts"],
    reason: "test imports Cursor SDK source in a child process",
  },
  {
    when: /^oxlint-plugin-t3code\//,
    workspaces: ["oxlint-plugin-t3code"],
    reason: "the rule tests lint with the plugin in a child process",
  },
  {
    when: /^packages\/effect-acp\/(?:src|test)\//,
    select: ["packages/effect-acp/src/client.test.ts", "packages/effect-acp/src/protocol.test.ts"],
    reason: "mock peer spawned in a child process",
  },
  {
    when: /^packages\/effect-codex-app-server\/(?:src|test)\//,
    select: ["packages/effect-codex-app-server/src/client.test.ts"],
    reason: "mock peer spawned in a child process",
  },
  {
    when: /^packages\/provider-acp-registry\/src\/server\/testing\//,
    select: ["packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts"],
    reason: "fixture scripts run by the test",
  },
  {
    when: /^apps\/mobile\/scripts\/fixtures\//,
    select: [
      "apps/mobile/scripts/notification-center-manager.test.ts",
      "apps/mobile/scripts/permissions-service.test.ts",
    ],
    reason: "native source fixtures read from disk",
  },
  {
    when: /^apps\/mobile\/(?:global\.css$|scripts\/)/,
    select: ["apps/mobile/scripts/generate-uniwind-themes.test.ts"],
    reason: "test reads global.css and the generator",
  },
  {
    when: /^apps\/mobile\/src\/lib\/uniwind-platform-variants\.fixture\.cjs$/,
    select: ["apps/mobile/src/lib/uniwind-platform-variants.test.ts"],
    reason: "fixture run in a child process",
  },
  {
    when: /^apps\/mobile\/(?:src|scripts)\//,
    select: [
      "apps/mobile/src/dependency-graph.test.ts",
      "apps/mobile/src/reactCompilerCoverage.test.ts",
    ],
    reason: "tests read every mobile source file",
  },
  {
    when: /^assets\//,
    select: ["apps/mobile/src/components/brandAssets.ts"],
    reason: "mobile requires brand images from assets/",
  },
  // Vitest's related-file graph drops `?raw` and `?inline` imports, so a file imported that way
  // reaches no test through it; test-landing.test.ts guards that every such import is mapped.
  {
    when: /^native\/libghostty-vt\/VERSION$/,
    select: ["apps/web/src/terminal/ghostty/runtimeAbi.test.ts"],
    reason: "imported with ?raw",
  },
  {
    when: /^apps\/web\/src\/terminal\/ghostty\/vendor\//,
    select: [
      "apps/web/src/terminal/ghostty/core.test.ts",
      "apps/web/src/terminal/ghostty/runtimeAbi.test.ts",
      "apps/web/src/terminal/ghostty/surface.test.ts",
    ],
    reason: "WebAssembly imported with ?inline",
  },
  {
    when: /^apps\/web\/index\.html$/,
    select: ["apps/web/src/themeBoot.test.ts"],
    reason: "imported with ?raw",
  },
  {
    when: /^apps\/web\/(?:src\/|index\.html$|public\/)/,
    select: ["apps/web/src/bundledDev.test.ts", "apps/web/src/reactCompilerCoverage.test.ts"],
    reason: "tests bundle and compile the web sources from disk",
  },
  {
    when: /^apps\/desktop\/gnome-extension\//,
    select: [
      "apps/desktop/src/snapShot/GnomeCaptureSetup.test.ts",
      "apps/desktop/src/snapShot/LinuxSnapShot.dbus.test.ts",
      "scripts/build-desktop-artifact.test.ts",
    ],
    reason: "extension bundle read from disk or imported across workspaces",
  },
  {
    when: /^(?:native\/browser-secret\/|apps\/desktop\/scripts\/build-browser-secret\.mjs$)/,
    select: ["apps/desktop/scripts/browser-secret-native.test.mjs"],
    reason: "test compiles the native source with the build script",
  },
  {
    when: /^apps\/desktop\/(?:src|scripts)\//,
    select: ["apps/desktop/scripts/main-process-bundle.test.mjs"],
    reason: "test bundles desktop main-process sources from disk",
  },
];
