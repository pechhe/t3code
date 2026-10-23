import { describe } from "@effect/vitest";

import { runOpenCodeReplayFixture } from "./OpenCodeReplayRuns.ts";
import { itRunsReplayFixtures } from "./ProviderReplayFixtures.ts";

// One of two files running this describe, so the fixtures run in parallel.
describe("OpenCode replay fixtures", () => {
  itRunsReplayFixtures("opencode", runOpenCodeReplayFixture, 0);
});
