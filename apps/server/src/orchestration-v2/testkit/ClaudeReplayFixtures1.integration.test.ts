import { describe } from "@effect/vitest";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, replayFixtureRunner } from "./ProviderReplayFixtures.ts";

// One of six files running this describe: tests within a file run one after another, so the
// driver's fixtures are spread over files that run in parallel.
describe("Claude Agent SDK replay fixtures", () => {
  itRunsReplayFixtures("claudeAgent", replayFixtureRunner(ClaudeOrchestratorReplayHarness), 0);
});
