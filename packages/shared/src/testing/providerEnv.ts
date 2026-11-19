// Agent shells carry real provider credentials (CLIProxy sets ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_BASE_URL) and the agent's own T3 state. Tests that read the ambient environment
// then pass or fail by who runs them. Tests that need one of these variables set it
// themselves. Set T3CODE_TEST_KEEP_PROVIDER_ENV=1 to keep them, for example for a live run.
const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "T3CODE_"];

const KEPT_ENV = new Set([
  // CI sets these so the transfer budget integration test writes its report for the job summary.
  "T3CODE_TRANSFER_BUDGET_REPORT_PATH",
  "T3CODE_TRANSFER_BUDGET_RESULT_PATH",
  "T3CODE_TRANSFER_BUDGET_SCENARIOS_PATH",
  // Opt-in: points the tests that launch a real browser at T3's pinned shell, which they skip
  // without (`none` asks for a run without one).
  "T3CODE_TEST_HEADLESS_SHELL",
  "T3CODE_TEST_BROWSER",
]);

if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV !== "1") {
  // A host gitconfig (insteadOf URL rewrites, aliases) changes what git prints, so tests that assert
  // remote URLs pass or fail by whose machine runs them.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const key of Object.keys(process.env)) {
    if (KEPT_ENV.has(key)) continue;
    if (PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
}
