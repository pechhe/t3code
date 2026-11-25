import { BLACKHOLE_DEFAULTS, type BlackholeConfig } from "./config.ts";
import type { SessionEntry } from "./session.ts";
import type { Message } from "./shims/pi-ai.ts";
import { buildGlobalIndexById } from "./upstream/core/global-indices.ts";
import { compile } from "./upstream/core/summarize.ts";
import { buildCompactionProjection } from "./upstream/om/ledger/projection.ts";
import {
  priorityOverflowNote,
  renderOptionsFromConfig,
  renderSummary,
} from "./upstream/om/ledger/render-summary.ts";
import type { Entry } from "./upstream/om/ledger/types.ts";

export interface CompactionResult {
  /** The block the fresh session starts from: the compiled summary, then memory and the recall note. */
  readonly text: string;
  /** Stored on the compaction so the next one merges into it, as Pi's compaction entry does. */
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly messageCount: number;
}

function fileOpsOf(messages: ReadonlyArray<Message>) {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
      if (path === undefined) continue;
      if (block.name === "read") read.add(path);
      else if (block.name === "write" || block.name === "edit") modified.add(path);
    }
  }
  return { readFiles: [...read], modifiedFiles: [...modified] };
}

/**
 * Blackhole's compact-all compaction of a session (pi-blackhole hooks/before-compact.ts): the
 * deterministic summary of everything since the last compaction merged into that compaction's
 * summary, followed by the observational memory projected at the tip. No model call.
 */
export function compileCompaction(input: {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly cwd: string;
  readonly memory: boolean;
  readonly config?: Partial<BlackholeConfig>;
}): CompactionResult | undefined {
  const config = { ...BLACKHOLE_DEFAULTS, ...input.config };
  const entries = input.entries as ReadonlyArray<SessionEntry>;
  const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
  const previous = lastCompaction >= 0 ? entries[lastCompaction] : undefined;
  const messageEntries = entries
    .slice(lastCompaction + 1)
    .filter((entry) => entry.type === "message");
  const messages = messageEntries.map((entry) => entry.message);
  const globalIndex = buildGlobalIndexById(entries);
  const summary = compile({
    messages,
    ...(previous?.type === "compaction" ? { previousSummary: previous.summary } : {}),
    fileOps: fileOpsOf(messages),
    sourceIndices: messageEntries.map((entry) => globalIndex.get(entry.id)),
    touchMessages: messages,
    cwd: input.cwd,
  });
  let memory = renderSummary([], []);
  let details: Record<string, unknown> = { compactor: "blackhole", version: 1 };
  let hasMemory = false;
  if (input.memory) {
    const projection = buildCompactionProjection(entries as Entry[], "", config);
    memory = renderSummary(
      projection.reflections,
      projection.observations,
      renderOptionsFromConfig(config),
    );
    const overflow = priorityOverflowNote(projection.priorityOverflow);
    if (overflow !== undefined) memory += `\n\n${overflow}`;
    details = { ...details, "om.folded": projection.details };
    hasMemory = projection.reflections.length > 0 || projection.observations.length > 0;
  }
  if (summary.trim() === "" && !hasMemory) return undefined;
  return { text: `${summary}\n\n${memory}`, summary, details, messageCount: messages.length };
}
