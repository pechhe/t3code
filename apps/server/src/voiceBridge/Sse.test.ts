import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { roleChunk, SSE_DONE, sseEvent, stopChunk, textChunk } from "./Sse.ts";

it.effect("writes the three chunk shapes a chat-completion client reads", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(roleChunk("id-1", 10, "codex/gpt-6.1-sol"), {
      id: "id-1",
      object: "chat.completion.chunk",
      created: 10,
      model: "codex/gpt-6.1-sol",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    assert.deepStrictEqual(textChunk("id-1", 10, "m", "hello").choices[0]?.delta, { content: "hello" });
    assert.strictEqual(stopChunk("id-1", 10, "m").choices[0]?.finish_reason, "stop");
  }),
);

it.effect("frames an event as one server-sent event, and ends with [DONE]", () =>
  Effect.sync(() => {
    assert.strictEqual(sseEvent({ a: 1 }), 'data: {"a":1}\n\n');
    assert.strictEqual(SSE_DONE, "data: [DONE]\n\n");
  }),
);
