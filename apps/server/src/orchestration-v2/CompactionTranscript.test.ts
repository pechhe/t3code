import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  clampCompactionSummary,
  DEFAULT_COMPACTION_WINDOW_TOKENS,
  renderCompactionTranscript,
} from "./CompactionTranscript.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

let ordinal = 0;
const base = () => ({
  id: `item-${ordinal}`,
  threadId: "thread",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: ordinal++,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const userMessage = (text: string): OrchestrationV2TurnItem =>
  ({
    ...base(),
    type: "user_message",
    text,
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    attachments: [],
  }) as unknown as OrchestrationV2TurnItem;

const assistantMessage = (text: string): OrchestrationV2TurnItem =>
  ({
    ...base(),
    type: "assistant_message",
    text,
    streaming: false,
  }) as unknown as OrchestrationV2TurnItem;

const command = (input: string, output: string): OrchestrationV2TurnItem =>
  ({
    ...base(),
    type: "command_execution",
    input,
    output,
    exitCode: 0,
  }) as unknown as OrchestrationV2TurnItem;

describe("renderCompactionTranscript", () => {
  it("reads the conversation oldest first with roles and tool outcomes", () => {
    const { text, omittedItems } = renderCompactionTranscript({
      items: [
        userMessage("Fix the login redirect"),
        assistantMessage("Reading the router."),
        command("rg redirect", "src/router.ts:12"),
      ],
      windowTokens: DEFAULT_COMPACTION_WINDOW_TOKENS,
    });

    expect(omittedItems).toBe(0);
    expect(text.indexOf("User:")).toBeLessThan(text.indexOf("Assistant:"));
    expect(text).toContain("Fix the login redirect");
    expect(text).toContain("Command: rg redirect");
    expect(text).toContain("src/router.ts:12");
  });

  it("keeps the original request and the newest items when the window is small", () => {
    const items = [
      userMessage("The original request"),
      ...Array.from({ length: 40 }, (_, index) =>
        assistantMessage(`Middle detail ${index} ${"x".repeat(2_000)}`),
      ),
      userMessage("The latest instruction"),
    ];

    const { text, omittedItems } = renderCompactionTranscript({
      items,
      windowTokens: 20_000,
    });

    expect(omittedItems).toBeGreaterThan(0);
    expect(text).toContain("The original request");
    expect(text).toContain("The latest instruction");
    expect(text).toContain("items between the start of the conversation");
  });

  it("marks a compaction inside the transcript instead of dropping it silently", () => {
    const items = [
      userMessage("Fix the login redirect"),
      { ...base(), type: "compaction", driver: "claudeAgent", title: "Compacted" } as never,
      assistantMessage("Continuing after compaction."),
    ];

    const { text } = renderCompactionTranscript({
      items,
      windowTokens: DEFAULT_COMPACTION_WINDOW_TOKENS,
    });

    expect(text).toContain("[Context was compacted here");
  });

  it("clamps a multi-byte summary by bytes, never in the middle of a character", () => {
    // A CJK summary is three bytes per character, so a character count would let it through
    // three times over the handoff budget.
    const summary = `${"登录重定向修复。".repeat(1_500)}\n\n${"后续步骤。".repeat(500)}`;

    const clamped = clampCompactionSummary(summary, 8_000);

    expect(Buffer.byteLength(clamped)).toBeLessThanOrEqual(8_000);
    expect(clamped).not.toContain("\uFFFD");
    expect(clamped.endsWith("[summary truncated]")).toBe(true);
    expect(clamped.length).toBeLessThan(summary.length);
  });

  it("truncates a summary at a paragraph break inside the handoff budget", () => {
    const summary = `${"a".repeat(600)}\n\n${"b".repeat(600)}\n\n${"c".repeat(600)}`;

    const clamped = clampCompactionSummary(summary, 1_300);

    expect(Buffer.byteLength(clamped)).toBeLessThanOrEqual(1_300);
    expect(clamped.startsWith("a".repeat(600))).toBe(true);
    expect(clamped.endsWith("[summary truncated]")).toBe(true);
  });

  it("leaves a summary that fits untouched", () => {
    expect(clampCompactionSummary("  short  ", 100)).toBe("short");
  });
});
