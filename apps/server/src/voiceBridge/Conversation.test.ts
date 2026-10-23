import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  conversationSignature,
  historyWithAnswer,
  type ChatMessage,
  lastUserText,
  messageText,
  threadTitle,
  threadLink,
  turnMessage,
} from "./Conversation.ts";
import { decodeSessions, EMPTY_SESSIONS, pruneSessions, rememberThread, threadFor } from "./Sessions.ts";

const messages: ReadonlyArray<ChatMessage> = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "summarise this page" },
  { role: "assistant", content: "It is a pricing page." },
  { role: "user", content: "which plan suits two people?" },
];

it.effect("reads the last thing the person said, including part-shaped content", () =>
  Effect.sync(() => {
    assert.strictEqual(lastUserText(messages), "which plan suits two people?");
    assert.strictEqual(
      messageText({
        role: "user",
        content: [
          { type: "text", text: "look at " },
          { type: "image_url", text: "ignored" },
          { type: "text", text: "this" },
        ],
      }),
      "look at this",
    );
  }),
);

it.effect("signs a history, so a grown or edited conversation signs differently", () =>
  Effect.sync(() => {
    const signature = conversationSignature(messages);
    const withAnswer = historyWithAnswer(messages, "It is a pricing page.");
    assert.notStrictEqual(conversationSignature(withAnswer), signature);
    // The same history always signs the same way, so a resent conversation finds
    // its thread, and a session that reuses a first message does not: its answer
    // differs by the time it grows.
    assert.strictEqual(conversationSignature(withAnswer), conversationSignature(withAnswer));
    const edited = [...withAnswer.slice(0, -1), { role: "assistant" as const, content: "Edited." }];
    assert.notStrictEqual(conversationSignature(edited), conversationSignature(withAnswer));
  }),
);

it.effect("titles a thread from the spoken words", () =>
  Effect.sync(() => {
    assert.strictEqual(threadTitle("  compare   these plans  "), "compare these plans");
    assert.strictEqual(
      threadTitle("one two three four five six seven eight nine ten"),
      "one two three four five six seven eight",
    );
    assert.strictEqual(threadTitle("   "), "Voice ask");
    assert.isTrue(threadTitle("a".repeat(120)).length <= 64);
  }),
);

it.effect("says where the capture is, and links the thread", () =>
  Effect.sync(() => {
    assert.strictEqual(turnMessage("do this", false), "do this");
    assert.include(turnMessage("do this", true), "do this\n\n");
    assert.strictEqual(threadLink("thread-1"), "t3-thread://v1/thread-1");
  }),
);

it.effect("remembers a thread for a conversation and forgets stale ones", () =>
  Effect.sync(() => {
    const now = 1_000_000_000;
    const store = rememberThread(EMPTY_SESSIONS, "key-a", "thread-1", now);
    assert.strictEqual(threadFor(store, "key-a"), "thread-1");
    assert.isNull(threadFor(store, "key-b"));

    const stale = rememberThread(store, "key-b", "thread-2", now - 8 * 24 * 60 * 60 * 1_000);
    const pruned = pruneSessions(stale, now);
    assert.strictEqual(threadFor(pruned, "key-a"), "thread-1");
    assert.isNull(threadFor(pruned, "key-b"));
  }),
);

it.effect("treats a broken session file as empty rather than failing", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(decodeSessions(undefined), EMPTY_SESSIONS);
    assert.deepStrictEqual(decodeSessions({ entries: "nope" }), EMPTY_SESSIONS);
    assert.deepStrictEqual(
      decodeSessions({ entries: { "key-a": { threadId: "thread-1" } } }),
      { version: 1, entries: { "key-a": { threadId: "thread-1", updatedAt: 0 } } },
    );
    assert.deepStrictEqual(decodeSessions({ entries: { "key-a": { threadId: 7 } } }), EMPTY_SESSIONS);
  }),
);
