import { compileCompaction, recall } from "@t3tools/blackhole";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildSession, entryIdOf } from "./BlackholeSession.ts";

let minute = 0;
const item = <T extends OrchestrationV2TurnItem["type"]>(
  id: string,
  fields: { readonly type: T } & Record<string, unknown>,
) => {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 10, minute++));
  return {
    id,
    threadId: "thread-1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: minute,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
};

const history = [
  item("u1", {
    type: "user_message",
    text: "Fix the login redirect, and never push to main.",
    attachments: [],
  }),
  item("c1", {
    type: "command_execution",
    input: "git commit -m 'fix(auth): keep the redirect'",
    output: "[main 4f2a9c1] fix(auth): keep the redirect\n 1 file changed",
    exitCode: 0,
  }),
  item("f1", {
    type: "file_change",
    title: "edit",
    fileName: "src/auth/login.ts",
    oldStr: "redirect(next)",
    newStr: "redirect(safe(next))",
  }),
  item("a1", { type: "assistant_message", text: "The redirect is fixed.", streaming: false }),
  item("k1", { type: "user_message", text: "/compact", attachments: [] }),
] as const;

describe("a T3 thread as a Blackhole session", () => {
  it("reads commands, file edits and messages as Pi's tool round trips", () => {
    const { entries, lastItemId } = buildSession({ items: history, records: [] });
    // `/compact` is a request, not conversation.
    expect(lastItemId).toBe("k1");
    expect(entries.map((entry) => entry.type === "message" && entry.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const compaction = compileCompaction({ entries, cwd: "/repo", memory: true });
    expect(compaction?.text).toContain("- 4f2a9c1: fix(auth): keep the redirect");
    expect(compaction?.text).toContain("src/auth/login.ts");
    expect(compaction?.text).toContain("Fix the login redirect, and never push to main.");
  });

  it("lets recall reach an edit's new text and a command's output", async () => {
    const { entries } = buildSession({ items: history, records: [] });
    expect(await recall(entries, { query: "#3:login.ts" })).toContain("redirect(safe(next))");
    expect(await recall(entries, { query: "4f2a9c1" })).toContain("fix(auth): keep the redirect");
  });

  it("drops memory written at an item that a rollback removed, as Pi's branch would", () => {
    const records = [
      {
        seq: 1,
        anchorItemId: "a1",
        customType: "om.reflections.recorded",
        data: {},
        createdAt: "",
      },
      {
        seq: 2,
        anchorItemId: "gone",
        customType: "om.reflections.recorded",
        data: {},
        createdAt: "",
      },
    ];
    const { entries } = buildSession({ items: history, records });
    const custom = entries.filter((entry) => entry.type === "custom");
    expect(custom.map((entry) => entry.id)).toEqual(["memory-1"]);
    // Memory sits right after the item it was written at.
    const at = entries.findIndex((entry) => entry.id === "memory-1");
    expect(entries[at - 1]?.id).toBe(entryIdOf("a1"));
  });

  it("treats a compaction as where the next one merges from", () => {
    const { entries } = buildSession({
      items: [
        ...history,
        item("x1", {
          type: "compaction",
          driver: "codex",
          summary: "[Session Goal]\n- Earlier goal",
        }),
        item("u2", { type: "user_message", text: "Now add a test for it.", attachments: [] }),
      ],
      records: [],
    });
    const compaction = compileCompaction({ entries, cwd: "/repo", memory: false });
    expect(compaction?.text).toContain("- Earlier goal");
    expect(compaction?.text).toContain("Now add a test for it.");
    expect(compaction?.messageCount).toBe(1);
  });
});
