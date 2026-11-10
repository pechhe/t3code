import { MessageId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { assert, describe, expect, it } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

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
      const { filter } = makeAssistantStreamingFilter("live");
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

type Step =
  // A snapshot at `at` ms, and the text it delivers at once (null when held back).
  | { readonly at: number; readonly text: string; readonly shows: string | null }
  | { readonly at: number; readonly final: string }
  | { readonly id: string; readonly at: number; readonly text: string; readonly shows: string }
  // Held snapshots due by `idle` ms, delivered whole.
  | { readonly idle: number; readonly shows: ReadonlyArray<string> }
  | { readonly dueAt: number | null };

const createdAt = DateTime.makeUnsafe(0);
const snapshot = (id: string, text: string, streaming: boolean) =>
  ({
    type: "message.updated",
    driver: ProviderDriverKind.make("codex"),
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: MessageId.make(id),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming,
      createdAt,
      updatedAt: createdAt,
    },
  }) satisfies ProviderAdapter.ProviderAdapterV2Event;
const shown = (event: ProviderAdapter.ProviderAdapterV2Event | null) =>
  event?.type === "message.updated" ? event.message.text : null;

it.each<{ readonly name: string; readonly mode?: "turn"; readonly steps: ReadonlyArray<Step> }>([
  {
    name: "an unfinished code fence",
    steps: [
      { at: 0, text: "A\n\n```ts\nx()", shows: "A\n\n" },
      { dueAt: 800 },
      { idle: 799, shows: [] },
      { idle: 800, shows: ["A\n\n```ts\nx()"] },
      { dueAt: null },
      { at: 1_300, text: "A\n\n```ts\nx()\n```\n\nB", shows: "A\n\n```ts\nx()\n```\n\n" },
    ],
  },
  {
    name: "a list's partial last item",
    steps: [
      { at: 0, text: "Steps:\n\n- one\n- tw", shows: "Steps:\n\n- one\n" },
      { idle: 800, shows: ["Steps:\n\n- one\n- tw"] },
      { at: 1_300, text: "Steps:\n\n- one\n- two\n- th", shows: "Steps:\n\n- one\n- two\n" },
    ],
  },
  {
    name: "an incomplete table row",
    steps: [
      { at: 0, text: "Intro.\n\n| a | b |\n|---|---|\n| 1 |", shows: "Intro.\n\n" },
      { idle: 800, shows: ["Intro.\n\n| a | b |\n|---|---|\n| 1 |"] },
      {
        at: 1_300,
        text: "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter",
        shows: "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
      },
    ],
  },
  {
    name: "more of the same paragraph after an idle delivery",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { idle: 800, shows: ["A\n\nB"] },
      { at: 900, text: "A\n\nB more", shows: null },
      { idle: 1_699, shows: [] },
      { idle: 1_700, shows: ["A\n\nB more"] },
      { idle: 5_000, shows: [] },
      // Its only boundary is behind what the idle delivery showed.
      { at: 5_100, text: "A\n\nB more and", shows: null },
      { at: 5_200, text: "A\n\nB more and.\n\nC", shows: "A\n\nB more and.\n\n" },
      { at: 5_300, final: "A\n\nB more and.\n\nC." },
      { idle: 10_000, shows: [] },
    ],
  },
  {
    name: "completion at the idle deadline",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { at: 800, final: "A\n\nB." },
      { idle: 800, shows: [] },
    ],
  },
  {
    name: "completion right after an idle delivery at the same instant",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { idle: 800, shows: ["A\n\nB"] },
      { at: 800, final: "A\n\nB." },
      { idle: 5_000, shows: [] },
    ],
  },
  {
    name: "several fast paragraphs inside the throttle",
    steps: [
      { at: 0, text: "A\n\nB", shows: "A\n\n" },
      { at: 100, text: "A\n\nB\n\nC", shows: null },
      { at: 200, text: "A\n\nB\n\nC\n\nD", shows: null },
      { at: 300, text: "A\n\nB\n\nC\n\nD\n\nE", shows: null },
      { idle: 1_099, shows: [] },
      { idle: 1_100, shows: ["A\n\nB\n\nC\n\nD\n\nE"] },
    ],
  },
  {
    name: "two messages due at different times",
    steps: [
      { id: "a", at: 0, text: "A\n\nx", shows: "A\n\n" },
      { id: "b", at: 300, text: "B\n\ny", shows: "B\n\n" },
      { dueAt: 800 },
      { idle: 800, shows: ["A\n\nx"] },
      { dueAt: 1_100 },
      { idle: 1_100, shows: ["B\n\ny"] },
    ],
  },
  {
    name: "empty text",
    steps: [{ at: 0, text: "", shows: null }, { dueAt: null }],
  },
  {
    name: "whitespace-only text",
    steps: [
      { at: 0, text: " \n", shows: null },
      { idle: 800, shows: [" \n"] },
      { idle: 5_000, shows: [] },
    ],
  },
  {
    // Rewrites replace delivered text: shorter at once, same length after the throttle.
    name: "provider rewrites and truncation",
    steps: [
      { at: 0, text: "Original long paragraph.\n\n", shows: "Original long paragraph.\n\n" },
      { at: 1_000, text: "New.\n\n", shows: "New.\n\n" },
      { at: 1_100, text: "Old.\n\n", shows: null },
      { idle: 1_900, shows: ["Old.\n\n"] },
      { at: 2_500, text: "Old", shows: null },
      { idle: 3_300, shows: ["Old"] },
      { at: 4_000, text: "", shows: null },
      { idle: 4_800, shows: [""] },
    ],
  },
  {
    name: "turn mode",
    mode: "turn",
    steps: [{ at: 0, text: "A\n\nB", shows: null }, { dueAt: null }],
  },
])("paragraph streaming holds and idle-delivers $name", ({ mode, steps }) => {
  const filter = makeAssistantStreamingFilter(mode ?? "paragraph", 800);
  for (const step of steps) {
    if ("dueAt" in step) assert.equal(filter.nextIdleFlushAt(), step.dueAt);
    else if ("idle" in step)
      assert.deepEqual(filter.takeIdleFlushes(step.idle).map(shown), [...step.shows]);
    else if ("final" in step)
      assert.equal(shown(filter.filter(snapshot("m", step.final, false), step.at)), step.final);
    else
      assert.equal(
        shown(filter.filter(snapshot("id" in step ? step.id : "m", step.text, true), step.at)),
        step.shows,
      );
  }
});
