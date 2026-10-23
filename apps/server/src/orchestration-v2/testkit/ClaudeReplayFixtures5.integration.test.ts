import { describe } from "@effect/vitest";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { itRunsReplayFixtures, replayFixtureRunner } from "./ProviderReplayFixtures.ts";

describe("Claude Agent SDK replay fixtures", () => {
  itRunsReplayFixtures("claudeAgent", replayFixtureRunner(ClaudeOrchestratorReplayHarness), 4);
});
