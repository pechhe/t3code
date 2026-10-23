import * as Effect from "effect/Effect";

import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import {
  readReplayFixtureTranscript,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";

/** OpenCode fixtures are recorded against either the v1 or the v2 HTTP protocol. */
export function runOpenCodeReplayFixture(input: ReplayFixtureCase) {
  return readReplayFixtureTranscript(input.driver.transcriptFile).pipe(
    Effect.flatMap((transcript) =>
      transcript.protocol === OPENCODE2_HTTP_PROTOCOL
        ? runReplayFixture({ ...input, harness: OpenCode2OrchestratorReplayHarness })
        : runReplayFixture({ ...input, harness: OpenCodeOrchestratorReplayHarness }),
    ),
  );
}
