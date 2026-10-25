import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2ThreadTranscript,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { TranscriptExportSection } from "~/lib/threadTranscriptMarkdown";

export interface TranscriptExportChild {
  readonly threadId: ThreadId;
  /** The brief the sub-agent thread was started with, as the parent recorded it. */
  readonly brief: string;
  /** When the parent started it, for ordering the document. */
  readonly startedAtIso: string | null;
}

/**
 * The sub-agent threads a thread started, in the order it started them. Read from the
 * thread's own `subagent` items rather than the client's thread list, so a thread whose
 * shell this client never loaded is still exported.
 */
export function subagentChildren(
  transcript: OrchestrationV2ThreadTranscript,
): ReadonlyArray<TranscriptExportChild> {
  const seen = new Set<ThreadId>();
  const children: TranscriptExportChild[] = [];
  for (const row of transcript.items) {
    const item = row.item;
    if (item.type !== "subagent" || item.childThreadId === null) continue;
    // A forked thread inherits its source's rows, so only its own sub-agents are its own.
    if (row.visibility !== "local" || item.threadId !== transcript.threadId) continue;
    if (seen.has(item.childThreadId)) continue;
    seen.add(item.childThreadId);
    children.push({
      threadId: item.childThreadId,
      brief: item.prompt,
      startedAtIso: item.startedAt === null ? null : DateTime.formatIso(item.startedAt),
    });
  }
  return children;
}

export interface TranscriptExportSections {
  readonly main: TranscriptExportSection;
  readonly subagents: ReadonlyArray<TranscriptExportSection>;
  readonly missing: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
}

/**
 * Every thread the export covers, in creation order: a thread, then the sub-agents it
 * started, each followed by theirs before the next sibling. A thread that cannot be read
 * is reported instead of dropping out of the document.
 */
export async function collectTranscriptSections(input: {
  readonly root: Pick<ScopedThreadRef, "environmentId" | "threadId">;
  readonly includeSubagents: boolean;
  readonly load: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ThreadId,
  ) => Promise<OrchestrationV2ThreadTranscript>;
  readonly describeFailure: (error: unknown) => string;
}): Promise<TranscriptExportSections> {
  const collected: Array<{ section: TranscriptExportSection; orderKey: string }> = [];
  const missing: Array<{ title: string; reason: string }> = [];

  const main = await input.load(input.root.environmentId, input.root.threadId);
  const root = { main: { title: main.title, brief: null, transcript: main }, collected, missing };
  if (!input.includeSubagents) return { ...root, subagents: [] };

  const visit = async (
    transcript: OrchestrationV2ThreadTranscript,
    environmentId: ScopedThreadRef["environmentId"],
  ): Promise<void> => {
    // A row with no recorded start takes its previous sibling's, so it stays where the
    // thread listed it rather than sorting to the end.
    let siblingStart: string | null = null;
    for (const child of subagentChildren(transcript)) {
      const orderKey = child.startedAtIso ?? siblingStart;
      if (child.startedAtIso !== null) siblingStart = child.startedAtIso;
      const childTranscript = await input
        .load(environmentId, child.threadId)
        .catch((error: unknown) => {
          missing.push({
            title: firstLine(child.brief) || child.threadId,
            reason: input.describeFailure(error),
          });
          return null;
        });
      if (childTranscript === null) continue;
      collected.push({
        section: {
          title: childTranscript.title,
          brief: child.brief,
          transcript: childTranscript,
        },
        orderKey: orderKey ?? "",
      });
      await visit(childTranscript, environmentId);
    }
  };
  await visit(main, input.root.environmentId);

  return {
    main: root.main,
    subagents: orderByStart(collected),
    missing,
  };
}

function orderByStart(
  collected: ReadonlyArray<{ section: TranscriptExportSection; orderKey: string }>,
): ReadonlyArray<TranscriptExportSection> {
  // Sections sort by when their parent started them; equal keys keep discovery order, so a
  // pre-order walk still decides between threads started at the same moment.
  return collected
    .map((entry, index) => ({ section: entry.section, key: entry.orderKey, index }))
    .sort((left, right) =>
      left.key === right.key ? left.index - right.index : left.key < right.key ? -1 : 1,
    )
    .map((entry) => entry.section);
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/u, 1)[0] ?? "").trim().slice(0, 120);
}

/**
 * Item counts for the dialog's summary line: a preview from the shells the client already
 * holds, so opening the dialog costs no request.
 */
export function transcriptExportItemCount(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  root: Pick<ScopedThreadRef, "environmentId" | "threadId">,
  includeSubagents: boolean,
): number {
  const counted = new Set<ThreadId>([root.threadId]);
  if (includeSubagents) {
    // Walk parents rather than the lineage's root: a fork and a sub-agent both inherit
    // their source's root id, so the root says nothing about who started whom.
    let frontier: ReadonlyArray<ThreadId> = [root.threadId];
    while (frontier.length > 0) {
      const next: ThreadId[] = [];
      for (const shell of shells) {
        if (shell.environmentId !== root.environmentId) continue;
        if (shell.lineage.relationshipToParent !== "subagent") continue;
        const parent = shell.lineage.parentThreadId;
        if (parent === null || !frontier.includes(parent) || counted.has(shell.id)) continue;
        counted.add(shell.id);
        next.push(shell.id);
      }
      frontier = next;
    }
  }
  return shells.reduce(
    (total, shell) =>
      shell.environmentId === root.environmentId && counted.has(shell.id)
        ? total + shell.visibleItemCount
        : total,
    0,
  );
}

/**
 * The transcript endpoint refuses a thread over the attachment cap, and that refusal is the
 * one failure a user can act on, so it names the limit instead of the endpoint's reason code.
 */
export function describeExportFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "An error occurred.";
  if (message.includes("thread_transcript_too_large")) {
    return "this thread is over the 50 MB transcript limit, so it was not exported.";
  }
  return message;
}
