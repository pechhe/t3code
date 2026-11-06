// What the import graph cannot see between workspaces and tests; see the landing gate in
// scripts/test-landing.ts. test-landing.test.ts fails when either table falls behind the code.

/**
 * Workspace edges the manifests do not declare: one imports the other by relative path.
 * test-landing.test.ts fails on a new undeclared edge.
 */
export const EXTRA_EDGES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["apps/desktop", "scripts"],
  ["apps/mobile", "scripts"],
  ["apps/server", "packages/client-runtime"],
  ["apps/server", "scripts"],
  ["evals", "apps/server"],
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

/**
 * Tests that read every test file in the repository to check these tables. A candidate that adds,
 * removes or renames a test file always runs them, and the budget never defers them.
 */
export const INVARIANT_GUARDS: ReadonlyArray<string> = ["scripts/test-landing.test.ts"];

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
    "cliCompileCache.test.ts",
    "outboundHttp.test.ts",
    "processRunner.test.ts",
    // Spawns apps/server/src/bin.ts to drive the managed runtime's CLI.
    "provider/CodexManagedRuntime.test.ts",
  ),
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
    "orchestration-v2/Adapters/KiroAdapterV2.test.ts",
    "orchestration-v2/OpenCode2OrchestratorV2.integration.test.ts",
    "orchestration-v2/testkit/AcpRegistryReplayFixtures.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures1.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures2.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures3.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures4.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures5.integration.test.ts",
    "orchestration-v2/testkit/ClaudeReplayFixtures6.integration.test.ts",
    "orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts",
    "orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts",
    "orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts",
    "orchestration-v2/testkit/ThreadFork.integration.test.ts",
    "orchestration-v2/testkit/ThreadMergeBack.integration.test.ts",
    "provider/OpenCode2Client.events.test.ts",
  ),
  // The dev replay agent reads its transcripts from disk when spawned.
  "apps/server/scripts/dev-replay-agent.test.ts",
];
const ACP_AGENT_SPAWNERS = [
  // The testkits spawn acp-replay-agent.ts; the tests that import them are found from here.
  ...serverTest(
    "orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts",
    "orchestration-v2/Adapters/GrokAdapterV2.testkit.ts",
    "orchestration-v2/Adapters/AcpAdapterV2.test.ts",
    "orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts",
    "orchestration-v2/Adapters/AntigravityAdapterV2.test.ts",
    "orchestration-v2/Adapters/FxAdapterV2.test.ts",
    "orchestration-v2/Adapters/GrokAdapterV2.test.ts",
    "orchestration-v2/Adapters/KiroAdapterV2.test.ts",
    "provider/AcpRegistryProbe.test.ts",
    "provider/Drivers/AntigravityDriver.test.ts",
    "provider/GrokProvider.test.ts",
    "provider/acp/AcpJsonRpcConnection.test.ts",
    "provider/acp/AcpSessionRuntime.processTree.test.ts",
  ),
];

export const INPUT_RULES: ReadonlyArray<InputRule> = [
  {
    when: /^apps\/mobile\/modules\/t3-highlights\/(?:cpp|tests)\//,
    select: ["apps/mobile/modules/t3-highlights/tests/utf16-to-utf8.test.ts"],
    reason: "run.sh compiles the highlights C++ sources from disk",
  },
  {
    when: /^apps\/server\/src\/speech\/catalog\.json$/,
    select: ["apps/server/scripts/speech-catalog.test.ts"],
    reason: "test compares the committed speech catalogue with a fresh render",
  },
  {
    when: /^evals\/pr-content\//,
    select: ["evals/pr-content/run.test.ts"],
    reason: "test spawns run.ts from disk",
  },
  {
    when: /^(?:apps\/server\/package\.json|packages\/[^/]+\/)/,
    select: ["apps/server/scripts/dev-watch.test.ts"],
    reason: "dev watcher reads its command and workspace source directories from disk",
  },
  {
    when: /^(?:apps\/server\/(?:src|scripts)\/|packages\/[^/]+\/src\/)/,
    select: SOURCE_SPAWNERS,
    reason: "source spawned in a child process",
  },
  {
    when: /^(?:apps|packages|scripts|fork)\/|^AGENTS\.md$/,
    select: ["scripts/legacy-name-allowlist.test.ts"],
    reason: "test greps every tracked file for the legacy product name outside its allowlist",
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
    when: /^\.github\/triage\//,
    select: serverTest("triage/triagePrompt.test.ts"),
    reason: "the bundled playbook must equal the repository copy",
  },
  {
    when: /^apps\/server\/scripts\/dev-replay\//,
    select: ["apps/server/scripts/dev-replay-agent.test.ts"],
    reason: "transcripts read from disk",
  },
  {
    when: /^apps\/server\/src\/persistence\/Migrations\//,
    select: ["apps/server/src/persistence/Migrations.test.ts"],
    reason: "test reads every migration file's name from disk",
  },
  {
    when: /^apps\/server\/src\/resourceTelemetry\/DesktopTelemetryReceiver\.ts$/,
    select: ["apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.test.ts"],
    reason: "the child process imports the module from disk",
  },
  {
    when: /^apps\/mobile\/src\/features\/layout\/AdaptiveWorkspaceLayout\.tsx$/,
    select: ["apps/mobile/src/features/threads/thread-inspector-navigation.test.tsx"],
    reason: "test compiles the layout with Babel from disk",
  },
  {
    when: /^apps\/web\/src\/components\/files\/(?:binary|office)Preview\.worker\.ts$/,
    select: ["apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx"],
    reason: "workers built from a URL the import graph does not follow",
  },
  {
    when: /^infra\/relay\/migrations\/postgres\//,
    select: ["infra/relay/src/environments/ManagedTunnelLimits.test.ts"],
    reason: "test applies the Postgres migrations from disk",
  },
  {
    when: /^infra\/task-cache\/vendor\//,
    select: ["infra/task-cache/src/Cleanup.test.ts"],
    reason: "test applies the vendored cache migration from disk",
  },
  {
    when: /^(?:scripts\/check-changed(?:-command)?\.ts|\.github\/scripts\/ci-changes\.cjs)$/,
    select: ["scripts/check-changed.test.ts", "scripts/check-changed-command.test.ts"],
    reason: "tests copy and run the checker and its CI entry from disk",
  },
  {
    when: /^scripts\/install\.(?:sh|ps1)$/,
    select: ["scripts/install.test.ts"],
    reason: "test runs the installer",
  },
  {
    when: /^scripts\/prepare-server-compile-cache\.cjs$/,
    select: ["scripts/lib/server-compile-cache.test.ts"],
    reason: "test requires the prepare script",
  },
  {
    when: /^scripts\/profile-startup\.mjs$/,
    select: ["scripts/profile-startup.test.ts"],
    reason: "test runs the profiling preload",
  },
  {
    when: /^docs\/user\/t3-connect-troubleshooting\.md$/,
    select: serverTest("cloud/ConnectReachability.test.ts"),
    reason: "test reads the troubleshooting guide",
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
    select: ["scripts/lib/third-party-licenses.test.ts", "evals/mcp-tool-use/devices.test.ts"],
    reason: "test reads the license inputs from disk",
  },
  {
    when: /^evals\/mcp-tool-use\/templates\//,
    select: ["evals/mcp-tool-use/devices.test.ts"],
    reason: "device templates read from disk",
  },
  {
    when: /^evals\/mcp-tool-use\/cases\//,
    select: ["evals/mcp-tool-use/run.test.ts"],
    reason: "eval cases read from disk",
  },
  {
    when: /^scripts\/npm-launcher\//,
    select: ["scripts/build-npm-launcher.test.ts"],
    reason: "launcher files are copied and run by the test",
  },
  {
    when: /^scripts\/fork-(?:nightly|reconcile-fixtures)\.sh$/,
    select: ["scripts/fork-nightly.test.ts"],
    reason: "test runs the script",
  },
  {
    when: /^apps\/mobile\/modules\/t3-highlights\/Vendor\/highlights\//,
    select: ["apps/mobile/scripts/generate-highlights.test.ts"],
    reason: "test reads the generated native highlights source from disk",
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
    select: [
      "apps/server/src/orchestration-v2/Adapters/CodexProcessGroup.test.ts",
      "packages/effect-codex-app-server/src/client.test.ts",
    ],
    reason: "mock peer spawned in a child process",
  },
  {
    when: /^packages\/provider-acp-registry\/src\/server\/testing\//,
    select: ["packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts"],
    reason: "fixture scripts run by the test",
  },
  {
    when: /^apps\/mobile\/(?:global\.css$|scripts\/)/,
    select: ["apps/mobile/scripts/generate-uniwind-themes.test.ts"],
    reason: "test reads global.css and the generator",
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
    when: /^native\/libghostty-vt\/include\/ghostty\/vt\/key\/event\.h$/,
    select: ["apps/web/src/terminal/ghostty/keyCodes.test.ts"],
    reason: "imported with ?raw",
  },
  {
    when: /^apps\/web\/src\/terminal\/ghostty\/vendor\//,
    select: [
      "apps/server/src/terminal/Manager.test.ts",
      "apps/web/src/terminal/ghostty/core.test.ts",
      "apps/web/src/terminal/ghostty/runtimeAbi.test.ts",
      "apps/web/src/terminal/ghostty/surface.test.ts",
    ],
    reason: "WebAssembly imported with ?inline, or read from disk",
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
  {
    when: /^infra\/task-cache\//,
    select: [
      "infra/task-cache/src/Savings.test.ts",
      "infra/task-cache/src/WriterRegistry.test.ts",
      "infra/task-cache/src/nativeHook.test.ts",
      "infra/task-cache/src/runHook.test.ts",
    ],
    reason: "the task cache's tests read its migrations, scripts and hooks from disk",
  },
];
