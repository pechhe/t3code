import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@t3tools/contracts";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { projectionFor } from "./fixtures/shared.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  replayFixtureRunner,
} from "./ProviderReplayFixtures.ts";

describe("Claude Agent SDK replay fixtures", () => {
  itRunsReplayFixtures("claudeAgent", replayFixtureRunner(ClaudeOrchestratorReplayHarness), 2);

  const runClaudeReplayFixture = replayFixtureRunner(ClaudeOrchestratorReplayHarness);
  const afterRootFixture = findReplayFixture("claude_background_subagent_after_root");
  const afterRootProvider = afterRootFixture?.providers[0];
  if (afterRootFixture !== undefined && afterRootProvider !== undefined) {
    // A subagent's foreground Bash run during the root's turn is tailed like a
    // root call's, so the child's command row streams live.
    const SUBAGENT_BASH_ID = "toolu_01JMN3SSQCHzUTNua9AWdkiH";
    it.effect("streams a subagent's foreground Bash output live during the root turn", () =>
      runClaudeReplayFixture({
        fixtureName: afterRootFixture.name,
        buildInput: afterRootFixture.buildInput,
        driver: {
          ...afterRootProvider,
          assertOutput: (result) => {
            const childThreadId = projectionFor(result, afterRootFixture.name).subagents[0]
              ?.childThreadId;
            assert.exists(childThreadId);
            const command = result.projections
              .get(childThreadId)
              ?.turnItems.find(
                (item) =>
                  item.type === "command_execution" &&
                  JSON.stringify(item.input).includes("SUB_DONE_1"),
              );
            assert.exists(command);
            const streamed = result.commandOutput?.get(command.id);
            assert.exists(streamed, "the subagent's command must stream its output");
            assert.include(streamed.output.text, "SUB_DONE_1");
          },
        },
        transformTranscript: (transcript) => {
          const isBashFrame = (entry: ProviderReplayEntry) => {
            if (entry.type !== "emit_inbound") return false;
            const frame = entry.frame as Record<string, any>;
            return (
              frame.message?.content?.[0]?.id === SUBAGENT_BASH_ID ||
              frame.message?.content?.[0]?.tool_use_id === SUBAGENT_BASH_ID ||
              (frame.type === "system" && frame.tool_use_id === SUBAGENT_BASH_ID)
            );
          };
          // Recorded without the structured result the replay writes output files from.
          const bashFrames = transcript.entries.filter(isBashFrame).map((entry) => {
            const frame = (entry as { readonly frame: Record<string, any> }).frame;
            return frame.type === "user"
              ? {
                  ...entry,
                  frame: { ...frame, tool_use_result: { stdout: "SUB_DONE_1\n", stderr: "" } },
                }
              : entry;
          });
          const rest = transcript.entries.filter((entry) => !isBashFrame(entry));
          const resultIndex = rest.findIndex(
            (entry) => entry.type === "emit_inbound" && entry.label === "result",
          );
          assert.lengthOf(bashFrames, 4, "transcript shape changed");
          assert.isAtLeast(resultIndex, 0, "transcript shape changed");
          return {
            ...transcript,
            entries: [...rest.slice(0, resultIndex), ...bashFrames, ...rest.slice(resultIndex)],
          };
        },
      }),
    );
  }
});
