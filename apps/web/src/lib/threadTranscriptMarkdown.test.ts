import type { OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTranscriptMarkdown,
  transcriptExportFilename,
  type TranscriptExportOptions,
} from "./threadTranscriptMarkdown";

const THREAD_ID = "thread-1" as OrchestrationV2ThreadTranscript["threadId"];

function transcript(
  title: string,
  items: ReadonlyArray<Record<string, unknown>>,
): OrchestrationV2ThreadTranscript {
  return {
    threadId: THREAD_ID,
    title,
    updatedAt: DateTime.makeUnsafe("2026-10-25T09:00:00.000Z"),
    items: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: THREAD_ID,
      sourceItemId: `item-${position}`,
      item: {
        id: `item-${position}`,
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: position,
        status: "completed",
        title: null,
        startedAt: DateTime.makeUnsafe(`2026-10-25T09:0${position}:00.000Z`),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(`2026-10-25T09:0${position}:00.000Z`),
        ...item,
      },
    })),
  } as unknown as OrchestrationV2ThreadTranscript;
}

const clock = (at: DateTime.Utc) => DateTime.formatIso(at).slice(11, 16);

const baseOptions: TranscriptExportOptions = {
  includeReasoning: false,
  includeToolOutput: false,
};

function build(
  main: OrchestrationV2ThreadTranscript,
  options: Partial<TranscriptExportOptions> = {},
  subagents: ReadonlyArray<{
    title: string;
    brief: string | null;
    transcript: OrchestrationV2ThreadTranscript;
  }> = [],
): string {
  return buildTranscriptMarkdown({
    meta: [{ label: "Thread", value: main.title }],
    main: { title: main.title, brief: null, transcript: main },
    subagents,
    options: { ...baseOptions, ...options },
    formatTime: clock,
  });
}

const conversation = transcript("Transcript export", [
  {
    type: "user_message",
    messageId: "m1",
    text: "Add an export.",
    attachments: [],
    inputIntent: "chat",
  },
  { type: "assistant_message", messageId: "m2", text: "Checking the code.", streaming: false },
  {
    type: "command_execution",
    input: "rg -n export apps\nsecond line",
    output: "12 matches\nmore",
    exitCode: 0,
  },
  { type: "reasoning", text: "The endpoint already exists.", streaming: false },
]);

describe("buildTranscriptMarkdown", () => {
  it("writes a message heading with the item's clock time", () => {
    const markdown = build(conversation);

    expect(markdown).toContain("## You · 09:00");
    expect(markdown).toContain("## Assistant · 09:01");
    expect(markdown).toContain("Add an export.");
  });

  it("condenses a command to one line with its exit code and first output line", () => {
    const markdown = build(conversation);

    expect(markdown).toContain("- `rg -n export apps` → exit 0 · 12 matches");
    expect(markdown).not.toContain("second line");
  });

  it("includes full command output when asked", () => {
    const markdown = build(conversation, { includeToolOutput: true });

    expect(markdown).toContain("$ rg -n export apps\nsecond line");
    expect(markdown).toContain("more");
  });

  it("leaves reasoning out by default and includes it on request", () => {
    expect(build(conversation)).not.toContain("The endpoint already exists.");

    const withReasoning = build(conversation, { includeReasoning: true });
    expect(withReasoning).toContain("> **Thinking** · 09:03");
    expect(withReasoning).toContain("> The endpoint already exists.");
  });

  it("reproduces a plan as written and lists todo steps", () => {
    const markdown = build(
      transcript("Planned", [
        {
          type: "proposed_plan",
          planId: "p1",
          markdown: "### Do it\n\n1. Fetch",
          streaming: false,
        },
        {
          type: "todo_list",
          planId: "p1",
          steps: [
            { id: "s1", text: "Fetch", status: "completed" },
            { id: "s2", text: "Format", status: "running" },
            { id: "s3", text: "Land", status: "pending" },
          ],
        },
      ]),
    );

    expect(markdown).toContain("### Plan\n\n### Do it\n\n1. Fetch");
    expect(markdown).toContain("- [x] Fetch");
    expect(markdown).toContain("- [~] Format");
    expect(markdown).toContain("- [ ] Land");
  });

  it("keeps a file change's diff and its line counts", () => {
    const markdown = build(
      transcript("Changed", [
        {
          type: "file_change",
          fileName: "apps/web/src/lib/thing.ts",
          additions: 3,
          deletions: 1,
          diffStr: "@@ -1 +1 @@\n-old\n+new",
          changes: [{ operation: "update", path: "apps/web/src/lib/thing.ts" }],
        },
      ]),
    );

    expect(markdown).toContain("- **apps/web/src/lib/thing.ts** +3 −1");
    expect(markdown).toContain("  - update: apps/web/src/lib/thing.ts");
    expect(markdown).toContain("```diff\n@@ -1 +1 @@\n-old\n+new\n```");
  });

  it("appends sub-agent threads with their briefs after the main thread", () => {
    const markdown = build(conversation, {}, [
      {
        title: "Worker · map the wiring",
        brief: "Map the four action lists.",
        transcript: transcript("Worker · map the wiring", [
          { type: "assistant_message", messageId: "s1", text: "Mapped.", streaming: false },
        ]),
      },
    ]);

    expect(markdown).toContain("# Sub-agent threads");
    expect(markdown).toContain("## 1 · Worker · map the wiring");
    expect(markdown).toContain("> Map the four action lists.");
    expect(markdown).toContain("### Assistant · 09:00\n\nMapped.");
    expect(markdown.indexOf("# Sub-agent threads")).toBeGreaterThan(
      markdown.indexOf("## Assistant · 09:01"),
    );
  });

  it("names a thread it could not read instead of dropping it silently", () => {
    const markdown = buildTranscriptMarkdown({
      meta: [{ label: "Thread", value: "Partial" }],
      main: { title: "Partial", brief: null, transcript: conversation },
      subagents: [],
      options: baseOptions,
      missing: [{ title: "Worker · big", reason: "this thread is over the 50 MB limit." }],
    });

    expect(markdown).toContain("## Not included");
    expect(markdown).toContain("- Worker · big: this thread is over the 50 MB limit.");
  });

  it("keeps blank lines inside a plan rather than collapsing them", () => {
    const markdown = build(
      transcript("Plan", [
        {
          type: "proposed_plan",
          planId: "p1",
          markdown: "Step one\n\n\nStep two",
          streaming: false,
        },
      ]),
    );

    expect(markdown).toContain("Step one\n\n\nStep two");
  });

  it("names the conversation events it carries instead of a bare type", () => {
    const markdown = build(
      transcript("Events", [
        {
          type: "fork",
          targetThreadId: "t2",
          source: { type: "run", threadId: "t1", runId: "r1" },
        },
        {
          type: "thread_created",
          targetThreadId: "t3",
          targetRunId: null,
          targetProviderInstanceId: "codex",
          targetModel: "gpt-6-luna",
        },
        {
          type: "handoff",
          contextHandoffId: "h1",
          fromProviderThreadIds: [],
          toProviderThreadId: "p2",
          fromProviderInstanceIds: [],
          toProviderInstanceId: "codex",
          strategy: "full_thread_summary",
        },
      ]),
    );

    expect(markdown).toContain("- Forked into another thread");
    expect(markdown).toContain("- Started thread on gpt-6-luna");
    expect(markdown).toContain("- Handed the conversation to codex");
    expect(markdown).not.toContain("- thread_created");
  });

  it("renders a type it has no case for without throwing", () => {
    const markdown = build(transcript("Forward", [{ type: "something_new", status: "completed" }]));

    expect(markdown).toContain("- something_new");
  });
});

describe("transcriptExportFilename", () => {
  it("names the file after the thread and the day it was exported", () => {
    expect(transcriptExportFilename("Transcript export: the sequel!", new Date(2026, 9, 25))).toBe(
      "transcript-export-the-sequel-transcript-2026-10-25.md",
    );
  });

  it("falls back to a usable name for a title with no words", () => {
    expect(transcriptExportFilename("***", new Date(2026, 0, 2))).toBe(
      "thread-transcript-2026-01-02.md",
    );
  });
});
