import { describe, expect, it } from "@effect/vitest";

import { piUsageFormat } from "./usage.ts";

describe("piUsageFormat", () => {
  it("keeps the transcript model's sub-provider as its slot attribution", () => {
    const records = piUsageFormat.parseLine(
      JSON.stringify({
        type: "usage",
        id: "message-1",
        timestamp: "2026-11-15T12:00:00.000Z",
        provider: "anthropic-hfpetch",
        model: "claude-sonnet-4",
        usage: { input: 100, output: 50, cost: { total: 0.002 } },
      }),
      { sessionId: "session-1" },
    );

    expect(records).toMatchObject([{ provider: "pi", accountKey: "anthropic-hfpetch" }]);
  });
});
