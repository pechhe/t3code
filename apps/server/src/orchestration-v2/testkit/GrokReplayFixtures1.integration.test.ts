import { describe } from "@effect/vitest";

import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { itRunsReplayFixtures, replayFixtureRunner } from "./ProviderReplayFixtures.ts";

// One of two files running this describe, so the fixtures run in parallel.
describe("Grok replay fixtures", () => {
  itRunsReplayFixtures("grok", replayFixtureRunner(GrokOrchestratorReplayHarness), 0);
});
