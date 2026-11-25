import { describe, expect, it } from "vite-plus/test";

import { buildBlackholeWorkerPrompt } from "./blackholeMemoryGeneration.ts";

const schemaIn = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));

describe("buildBlackholeWorkerPrompt", () => {
  // Runners without native structured output see only the prompt, and pi-blackhole's own
  // prompts leave `supersedes` optional, so a reply without it failed every observer pass.
  it("spells out every field the reply must carry", () => {
    const observer = schemaIn(
      buildBlackholeWorkerPrompt({
        stage: "observer",
        system: "You are the Observer.",
        prompt: "Compress this chunk.",
        toolName: "record_observations",
      }),
    );
    expect(observer.required).toEqual(["observations", "complete"]);
    expect(observer.properties.observations.items.required).toEqual([
      "content",
      "relevance",
      "sourceEntryIds",
      "supersedes",
    ]);

    const dropper = schemaIn(
      buildBlackholeWorkerPrompt({
        stage: "dropper",
        system: "You are the Dropper.",
        prompt: "Drop what is stale.",
        toolName: "drop_observations",
      }),
    );
    expect(dropper.required).toEqual(["ids", "reason"]);
  });
});
