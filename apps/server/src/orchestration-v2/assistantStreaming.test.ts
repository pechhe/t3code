import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { MessageId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { describe, expect, it } from "vite-plus/test";
import { splitBufferedAssistantText } from "./assistantStreaming.ts";

const message = (text: string, streaming = true): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it.each([message, turnItem])(
    "delivers growing live text without a paragraph boundary, caps bursts at 45ms, and flushes completion (%#)",
    (update) => {
      const filter = makeAssistantStreamingFilter("live");
      const first = update("First");
      expect(filter(first, 0)).toBe(first);
      expect(filter(update("First sentence"), 1)).toBeNull();
      expect(filter(update("First sentence grows"), 44)).toBeNull();
      // Adapter batches arrive about every 50ms and all pass.
      const grown = update("First sentence grows further");
      expect(filter(grown, 50)).toBe(grown);
      expect(filter(update("First sentence grows further still"), 60)).toBeNull();
      const final = update("First sentence grows further still. Done.", false);
      expect(filter(final, 60)).toBe(final);
    },
  );

  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});
