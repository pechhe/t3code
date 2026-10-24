import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as AgentCliClient from "../cli/AgentCliClient.ts";
import { makePort } from "./T3Port.ts";

type Call = { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };

type StreamItem = {
  readonly position: number;
  readonly itemId: string;
  readonly type: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly nextTextOffset?: number | null;
};

const streamItem = (
  position: number,
  type: string,
  text: string | null,
  title: string | null = null,
): StreamItem => ({
  position,
  itemId: `item-${position}`,
  type,
  title,
  text,
  textTruncated: false,
});

const readResult = (input: {
  readonly status?: string;
  readonly requests?: number;
  readonly items: ReadonlyArray<StreamItem>;
  readonly hasMore?: boolean;
  readonly nextPosition?: number | null;
}) => ({
  thread: {
    status: input.status ?? "running",
    pendingRequestCount: input.requests ?? 0,
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
  },
  items: input.items,
  nextPosition: input.nextPosition === undefined ? null : input.nextPosition,
  hasMore: input.hasMore ?? false,
});

/**
 * The port over a fake MCP client, so the contract it keeps with `t3_thread_read`
 * is checked where it is easy to get wrong: pagination and long items.
 */
const makeClient = (
  calls: Ref.Ref<ReadonlyArray<Call>>,
  answer: (call: Call) => unknown,
): Pick<AgentCliClient.AgentCliClient["Service"], "call"> => ({
  call: (_endpoint, tool, args) =>
    Effect.gen(function* () {
      const call = { tool, args };
      yield* Ref.update(calls, (all) => [...all, call]);
      return answer(call);
    }),
});

it.effect("follows activity pages to the current approval, not the first page's", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const port = makePort(
      makeClient(calls, (call) => {
        if (call.tool !== "t3_thread_read") return {};
        const after = call.args["afterPosition"];
        if (call.args["view"] !== "activity") return readResult({ items: [] });
        return after === undefined
          ? readResult({
              items: [streamItem(1, "approval_request", null, "Old resolved permission.")],
              hasMore: true,
              nextPosition: 2,
            })
          : readResult({
              items: [streamItem(101, "approval_request", null, "Run the tests?")],
              hasMore: false,
            });
      }),
      "http://127.0.0.1:3773/mcp",
    );

    assert.strictEqual(yield* port.pendingApproval("thread-1"), "Run the tests?");
    const activityReads = (yield* Ref.get(calls)).filter((call) => call.args["view"] === "activity");
    assert.lengthOf(activityReads, 2);
    assert.strictEqual(activityReads[1]?.args["afterPosition"], 1);
  }),
);

it.effect("names a question before an approval, and falls back to no name", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const port = makePort(
      makeClient(calls, (call) => {
        if (call.tool === "t3_pending_request_list") return { requestIds: ["request-1"] };
        if (call.tool === "t3_pending_request_read")
          return { requestId: "request-1", questions: [{ header: "Which branch?", question: "Which?" }] };
        return readResult({ items: [] });
      }),
      "http://127.0.0.1:3773/mcp",
    );

    assert.strictEqual(yield* port.pendingQuestion("thread-1"), "Which branch?");
  }),
);

it.effect("reads an item whole when the first page cuts it short", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const port = makePort(
      makeClient(calls, (call) => {
        if (call.tool !== "t3_thread_read") return {};
        const offset = call.args["textOffset"];
        if (offset === undefined) {
          return readResult({
            items: [
              {
                ...streamItem(1, "assistant_message", "first half "),
                textTruncated: true,
                nextTextOffset: 11,
              },
            ],
          });
        }
        return readResult({
          items: [
            {
              ...streamItem(1, "assistant_message", "second half"),
              textTruncated: false,
              nextTextOffset: null,
            },
          ],
        });
      }),
      "http://127.0.0.1:3773/mcp",
    );

    const page = yield* port.readThread("thread-1");
    assert.strictEqual(page.items[0]?.text, "first half second half");
    assert.strictEqual(page.lastPosition, 1);
  }),
);

it.effect("builds a thread link the reader's app can open, and falls back without an id", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const withId = makePort(
      makeClient(calls, (call) =>
        call.tool === "orchestrator_capabilities" ? { environmentId: "env-1", providers: [] } : {},
      ),
      "http://127.0.0.1:3773/mcp",
    );
    assert.strictEqual(
      yield* withId.threadUrl("thread-1"),
      "http://127.0.0.1:3773/env-1/thread-1",
    );

    const withoutId = makePort(
      makeClient(calls, () => ({ providers: [] })),
      "http://127.0.0.1:3773/mcp",
    );
    assert.strictEqual(yield* withoutId.threadUrl("thread-1"), "t3-thread://v1/thread-1");
  }),
);

it.effect("asks for the thread after the cursor it was given", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const port = makePort(
      makeClient(calls, () => readResult({ items: [] })),
      "http://127.0.0.1:3773/mcp",
    );

    yield* port.readThread("thread-1", { afterPosition: 7 });
    const read = (yield* Ref.get(calls)).find((call) => call.tool === "t3_thread_read");
    assert.strictEqual(read?.args["afterPosition"], 7);
    assert.strictEqual(read?.args["view"], "messages");
  }),
);
