import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationV2ThreadTranscript } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  collectTranscriptSections,
  describeExportFailure,
  subagentChildren,
  transcriptExportItemCount,
} from "./ExportTranscriptDialog.logic";

const ROOT = {
  environmentId: "env-1" as EnvironmentThreadShell["environmentId"],
  threadId: "root" as EnvironmentThreadShell["id"],
};

function subagentRow(input: {
  childThreadId: string | null;
  prompt: string;
  startedAt?: string;
  visibility?: "local" | "inherited" | "synthetic";
  itemThreadId?: string;
}): Record<string, unknown> {
  return {
    visibility: input.visibility ?? "local",
    item: {
      type: "subagent",
      subagentId: `node-${input.childThreadId ?? "none"}`,
      origin: "app_owned",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      childThreadId: input.childThreadId,
      prompt: input.prompt,
      status: "completed",
      ...(input.itemThreadId === undefined ? {} : { threadId: input.itemThreadId }),
      startedAt: input.startedAt === undefined ? null : DateTime.makeUnsafe(input.startedAt),
    },
  };
}

function transcript(
  title: string,
  threadId: string,
  rows: ReadonlyArray<Record<string, unknown>> = [],
): OrchestrationV2ThreadTranscript {
  return {
    threadId,
    title,
    updatedAt: DateTime.makeUnsafe("2026-10-25T09:00:00.000Z"),
    items: rows.map((row, position) => ({
      position,
      visibility: row.visibility ?? "local",
      sourceThreadId: threadId,
      sourceItemId: `item-${position}`,
      item: {
        id: `item-${position}`,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: position,
        status: "completed",
        title: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-25T09:00:00.000Z"),
        ...(row.item as Record<string, unknown>),
      },
    })),
  } as unknown as OrchestrationV2ThreadTranscript;
}

function shell(input: {
  id: string;
  parent: string | null;
  relationship?: "fork" | "subagent";
  visibleItemCount?: number;
  rootThreadId?: string;
}): EnvironmentThreadShell {
  return {
    id: input.id,
    environmentId: ROOT.environmentId,
    visibleItemCount: input.visibleItemCount ?? 0,
    lineage: {
      parentThreadId: input.parent,
      relationshipToParent: input.parent === null ? null : (input.relationship ?? "subagent"),
      rootThreadId: input.rootThreadId ?? ROOT.threadId,
    },
  } as unknown as EnvironmentThreadShell;
}

describe("subagentChildren", () => {
  it("lists the threads a thread started, with the brief and the time it started", () => {
    const children = subagentChildren(
      transcript("Root", "root", [
        subagentRow({
          childThreadId: "second",
          prompt: "Second brief",
          startedAt: "2026-10-25T09:20:00.000Z",
        }),
        subagentRow({
          childThreadId: "first",
          prompt: "First brief",
          startedAt: "2026-10-25T09:10:00.000Z",
        }),
      ]),
    );

    expect(children).toEqual([
      { threadId: "second", brief: "Second brief", startedAtIso: "2026-10-25T09:20:00.000Z" },
      { threadId: "first", brief: "First brief", startedAtIso: "2026-10-25T09:10:00.000Z" },
    ]);
  });

  it("skips a sub-agent with no thread to read, and a thread named twice", () => {
    const children = subagentChildren(
      transcript("Root", "root", [
        subagentRow({ childThreadId: null, prompt: "Provider-native, nothing to fetch" }),
        subagentRow({ childThreadId: "a", prompt: "First brief" }),
        subagentRow({ childThreadId: "a", prompt: "Repeated spawn" }),
      ]),
    );

    expect(children.map((child) => child.threadId)).toEqual(["a"]);
  });

  it("leaves out the sub-agents a fork inherited from the thread it came from", () => {
    const children = subagentChildren(
      transcript("Fork", "fork", [
        subagentRow({
          childThreadId: "source-helper",
          prompt: "Started by the source thread",
          visibility: "inherited",
          itemThreadId: "source",
        }),
        subagentRow({ childThreadId: "own-helper", prompt: "Started here" }),
      ]),
    );

    expect(children.map((child) => child.threadId)).toEqual(["own-helper"]);
  });
});

describe("collectTranscriptSections", () => {
  const catalogue: Record<string, OrchestrationV2ThreadTranscript> = {
    // A starts at 09:10, B at 09:11, and A's own sub-agent G only at 09:20.
    root: transcript("Root", "root", [
      subagentRow({ childThreadId: "a", prompt: "A brief", startedAt: "2026-10-25T09:10:00.000Z" }),
      subagentRow({ childThreadId: "b", prompt: "B brief", startedAt: "2026-10-25T09:11:00.000Z" }),
    ]),
    a: transcript("A", "a", [
      subagentRow({ childThreadId: "g", prompt: "G brief", startedAt: "2026-10-25T09:20:00.000Z" }),
    ]),
    b: transcript("B", "b"),
    g: transcript("G", "g"),
  };
  const load = async (_environmentId: string, threadId: string) => {
    const found = catalogue[threadId];
    if (found === undefined) throw new Error(`no transcript for ${threadId}`);
    return found;
  };

  it("orders every thread by when it was started, not by generation", async () => {
    const sections = await collectTranscriptSections({
      root: ROOT,
      includeSubagents: true,
      load: load as never,
      describeFailure: describeExportFailure,
    });

    expect(sections.subagents.map((section) => section.title)).toEqual(["A", "B", "G"]);
    expect(sections.subagents.map((section) => section.brief)).toEqual([
      "A brief",
      "B brief",
      "G brief",
    ]);
  });

  it("keeps a section with no recorded start next to the siblings it was found with", async () => {
    const untimed: Record<string, OrchestrationV2ThreadTranscript> = {
      ...catalogue,
      root: transcript("Root", "root", [
        subagentRow({
          childThreadId: "a",
          prompt: "A brief",
          startedAt: "2026-10-25T09:10:00.000Z",
        }),
        subagentRow({ childThreadId: "b", prompt: "B brief" }),
      ]),
    };
    const sections = await collectTranscriptSections({
      root: ROOT,
      includeSubagents: true,
      load: (async (_environmentId: string, threadId: string) => untimed[threadId]!) as never,
      describeFailure: describeExportFailure,
    });

    // G starts at 09:20, after B was started, but B's start is unrecorded: it stays where
    // the thread listed it, before G, rather than moving to the end of the document.
    expect(sections.subagents.map((section) => section.title)).toEqual(["A", "B", "G"]);
  });

  it("keeps a first child with no recorded start under its own parent, not at the front", async () => {
    const untimedFirst: Record<string, OrchestrationV2ThreadTranscript> = {
      ...catalogue,
      a: transcript("A", "a", [
        subagentRow({ childThreadId: "x", prompt: "X brief" }),
        subagentRow({
          childThreadId: "y",
          prompt: "Y brief",
          startedAt: "2026-10-25T09:15:00.000Z",
        }),
      ]),
      x: transcript("X", "x"),
      y: transcript("Y", "y"),
    };
    const sections = await collectTranscriptSections({
      root: ROOT,
      includeSubagents: true,
      load: (async (_environmentId: string, threadId: string) => untimedFirst[threadId]!) as never,
      describeFailure: describeExportFailure,
    });

    // X was started by A but its row records no start, so it follows A rather than leading
    // the document; the timed sections after it follow their own start times (B at 09:11,
    // Y at 09:15), not the shape of the tree.
    expect(sections.subagents.map((section) => section.title)).toEqual(["A", "X", "B", "Y"]);
  });

  it("names a thread it cannot read and keeps its siblings", async () => {
    const sections = await collectTranscriptSections({
      root: ROOT,
      includeSubagents: true,
      load: (async (_environmentId: string, threadId: string) => {
        if (threadId === "a") throw new Error("this thread is over the 50 MB transcript limit");
        return catalogue[threadId]!;
      }) as never,
      describeFailure: describeExportFailure,
    });

    expect(sections.subagents.map((section) => section.title)).toEqual(["B"]);
    expect(sections.missing).toEqual([
      { title: "A brief", reason: "this thread is over the 50 MB transcript limit" },
    ]);
  });

  it("reads only the exported thread when sub-agent threads are off", async () => {
    const requested: string[] = [];
    const sections = await collectTranscriptSections({
      root: ROOT,
      includeSubagents: false,
      load: (async (_environmentId: string, threadId: string) => {
        requested.push(threadId);
        return catalogue[threadId]!;
      }) as never,
      describeFailure: describeExportFailure,
    });

    expect(requested).toEqual(["root"]);
    expect(sections.subagents).toEqual([]);
  });
});

describe("transcriptExportItemCount", () => {
  it("counts the exported thread and the sub-agent threads under it, never a fork's", () => {
    const shells = [
      shell({ id: "root", parent: null, visibleItemCount: 10 }),
      shell({ id: "child", parent: "root", visibleItemCount: 4 }),
      shell({ id: "grandchild", parent: "child", visibleItemCount: 2 }),
      shell({ id: "forked", parent: "root", relationship: "fork", visibleItemCount: 3 }),
    ];

    expect(transcriptExportItemCount(shells, ROOT, true)).toBe(16);
    expect(transcriptExportItemCount(shells, ROOT, false)).toBe(10);
  });

  it("counts a sub-agent's own sub-agents when it is the exported thread", () => {
    const shells = [
      shell({ id: "root", parent: null, visibleItemCount: 10, rootThreadId: "root" }),
      shell({ id: "child", parent: "root", visibleItemCount: 4, rootThreadId: "root" }),
      shell({ id: "grandchild", parent: "child", visibleItemCount: 2, rootThreadId: "root" }),
    ];

    expect(transcriptExportItemCount(shells, { ...ROOT, threadId: "child" as never }, true)).toBe(
      6,
    );
  });
});

describe("describeExportFailure", () => {
  it("names the size limit when the transcript is too large to fetch", () => {
    expect(describeExportFailure(new Error("(thread_transcript_too_large)"))).toContain("50 MB");
  });

  it("passes any other failure through unchanged", () => {
    expect(describeExportFailure(new Error("The source environment is not connected."))).toBe(
      "The source environment is not connected.",
    );
  });
});
