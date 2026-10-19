import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as IdAllocator from "./IdAllocator.ts";

describe("IdAllocator", () => {
  it.effect("allocates a stream's event ids in the order they were allocated", () =>
    Effect.gen(function* () {
      const allocator = yield* IdAllocator.IdAllocatorV2;
      yield* TestClock.setTime(Date.UTC(2026, 9, 19, 17, 0, 0));
      const ids: Array<string> = [];
      for (let index = 0; index < 20; index += 1) {
        ids.push(yield* allocator.allocate.event({ threadId: ThreadId.make("thread-1") }));
        yield* TestClock.adjust("1 millis");
      }
      assert.deepEqual([...ids].sort(), ids);
      assert.equal(new Set(ids).size, ids.length);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});
