import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadWatchers } from "./shellThreadWatches.ts";

const worker = ThreadId.make("thread:worker");

const shell = (
  id: string,
  watches: ReadonlyArray<{ readonly threadId: ThreadId; readonly startedAt: string }>,
  archivedAt: string | null = null,
  deletedAt: string | null = null,
) => ({
  id: ThreadId.make(id),
  archivedAt,
  deletedAt,
  threadWatches: watches.map((watch, index) => ({
    id: `thread-watch:${id}:${index}`,
    title: "Worker",
    ...watch,
  })),
});

describe("threadWatchers", () => {
  it("lists the active watchers of a thread, oldest watch first", () => {
    const shells = [
      shell("thread:late", [{ threadId: worker, startedAt: "2026-10-17T10:00:00.000Z" }]),
      shell("thread:early", [{ threadId: worker, startedAt: "2026-10-17T09:00:00.000Z" }]),
      shell("thread:other", [
        { threadId: ThreadId.make("thread:else"), startedAt: "2026-10-17T09:00:00.000Z" },
      ]),
      shell(
        "thread:archived",
        [{ threadId: worker, startedAt: "2026-10-17T08:00:00.000Z" }],
        "2026-10-17T11:00:00.000Z",
      ),
      shell(
        "thread:deleted",
        [{ threadId: worker, startedAt: "2026-10-17T08:00:00.000Z" }],
        null,
        "2026-10-17T11:00:00.000Z",
      ),
      { id: ThreadId.make("thread:none"), archivedAt: null, deletedAt: null },
    ];
    expect(threadWatchers(shells, worker).map((watcher) => watcher.id)).toEqual([
      "thread:early",
      "thread:late",
    ]);
  });
});
