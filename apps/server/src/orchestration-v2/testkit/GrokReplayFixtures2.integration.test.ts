import { describe } from "@effect/vitest";

import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { itRunsReplayFixtures, replayFixtureRunner } from "./ProviderReplayFixtures.ts";

describe("Grok replay fixtures", () => {
  itRunsReplayFixtures("grok", replayFixtureRunner(GrokOrchestratorReplayHarness), 1);
});
