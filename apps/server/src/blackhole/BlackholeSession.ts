// @effect-diagnostics nodeBuiltinImport:off - a synchronous hash for stable short entry ids.
import type { Message, SessionEntry } from "@t3tools/blackhole";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";

/** A ledger record as stored for a thread: placed after the conversation item it was written at. */
export interface StoredMemoryRecord {
  readonly seq: number;
  readonly anchorItemId: string;
  readonly customType: string;
  readonly data: unknown;
  readonly createdAt: string;
  /** Set on a record a fork inherits, keeping its entry id apart from the fork's own. */
  readonly inheritedFrom?: string;
}

/** The turn items a Blackhole session is built from, oldest first. */
export const BLACKHOLE_ITEM_TYPES: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "user_input_request",
  "command_execution",
  "file_change",
  "dynamic_tool",
  "file_search",
  "web_search",
  "subagent",
  "compaction",
];

// Harness tool names Blackhole's extractors know by their Pi names.
const TOOL_ALIASES: Record<string, string> = {
  Read: "read",
  read_file: "read",
  view_file: "read",
  Write: "write",
  write_file: "write",
  write_to_file: "write",
  Edit: "edit",
  MultiEdit: "edit",
  edit_file: "edit",
  replace_file_content: "edit",
  Bash: "bash",
  shell: "bash",
  run_command: "bash",
};

/** Pi-style short entry ids keep observer chunks and `[Source entry id: …]` labels small. */
export const entryIdOf = (itemId: string, part = ""): string =>
  NodeCrypto.createHash("sha256").update(`${itemId}${part}`).digest("hex").slice(0, 8);

const iso = (value: DateTime.Utc | null): string | undefined =>
  value === null ? undefined : DateTime.formatIso(value);

const textOfOutput = (output: unknown): string => {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && Array.isArray((output as { content?: unknown }).content)) {
    return (output as { content: Array<{ type?: string; text?: string }> }).content
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type ?? "content"}]`))
      .join("\n");
  }
  return JSON.stringify(output) ?? "";
};

const argumentsOf = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : input === undefined || input === null
      ? {}
      : { input };

/** The tool call and its result, as Pi records a tool round trip. */
function toolRoundTrip(
  item: OrchestrationV2TurnItem,
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  details?: unknown,
): Message[] {
  const timestamp = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
  const toolCallId = item.id;
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
      stopReason: "toolUse",
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId,
      toolName: name,
      content: [{ type: "text", text: result }],
      isError,
      ...(details === undefined ? {} : { details }),
      timestamp,
    },
  ];
}

function fileChangeCall(item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>) {
  const path = item.fileName;
  const created = item.title === "write" || (item.oldStr === "" && item.newStr !== undefined);
  if (created) return { name: "write", args: { path, content: item.newStr ?? item.diffStr ?? "" } };
  if (item.oldStr !== undefined || item.newStr !== undefined)
    return { name: "edit", args: { path, oldText: item.oldStr ?? "", newText: item.newStr ?? "" } };
  return { name: "edit", args: { path, oldText: "", newText: item.diffStr ?? "" } };
}

function answerDetails(item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>) {
  const answer = item.questionAnswer;
  if (answer === undefined) return undefined;
  return {
    answers: item.questions.map((question) => {
      const raw = answer.answers[question.id];
      const values = (Array.isArray(raw) ? raw : [raw]).filter(
        (value): value is string => typeof value === "string",
      );
      const labels = new Set(question.options.map((option) => option.label));
      const selected = values.filter((value) => labels.has(value));
      const free = values.filter((value) => !labels.has(value)).join("\n");
      return { question: question.question, selected, ...(free === "" ? {} : { answer: free }) };
    }),
  };
}

/** One turn item as Pi messages; empty when Blackhole has nothing to read in it. */
function messagesOf(item: OrchestrationV2TurnItem): Message[] {
  const timestamp = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
  switch (item.type) {
    case "user_message":
      // `/compact` asks for a compaction; it is not conversation.
      if (item.text.trim().toLowerCase() === "/compact" && item.attachments.length === 0) return [];
      return [
        {
          role: "user",
          content: [
            { type: "text", text: item.text },
            ...item.attachments.flatMap((attachment) =>
              attachment.type === "image"
                ? [{ type: "image" as const, data: "", mimeType: attachment.mimeType }]
                : [],
            ),
          ],
          timestamp,
        },
      ];
    case "assistant_message":
      return item.text.trim() === ""
        ? []
        : [{ role: "assistant", content: [{ type: "text", text: item.text }], timestamp }];
    case "reasoning":
      return item.text.trim() === ""
        ? []
        : [{ role: "assistant", content: [{ type: "thinking", thinking: item.text }], timestamp }];
    case "proposed_plan":
      return [{ role: "assistant", content: [{ type: "text", text: item.markdown }], timestamp }];
    case "command_execution":
      return toolRoundTrip(
        item,
        "bash",
        { command: item.input },
        item.output ?? "",
        item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0,
      );
    case "file_change": {
      const call = fileChangeCall(item);
      return toolRoundTrip(
        item,
        call.name,
        call.args,
        item.status === "failed"
          ? `Failed to change ${item.fileName}.`
          : `Changed ${item.fileName}.`,
        item.status === "failed",
      );
    }
    case "dynamic_tool": {
      const name = item.toolName ?? "tool";
      return toolRoundTrip(
        item,
        TOOL_ALIASES[name] ?? name,
        argumentsOf(item.input),
        textOfOutput(item.output),
        item.status === "failed",
      );
    }
    case "file_search":
      return toolRoundTrip(
        item,
        "grep",
        { pattern: item.pattern ?? "" },
        (item.results ?? []).map((result) => JSON.stringify(result)).join("\n"),
        item.status === "failed",
      );
    case "web_search":
      return toolRoundTrip(
        item,
        "web_search",
        { query: (item.patterns ?? []).join(" ") },
        (item.results ?? []).map((result) => JSON.stringify(result)).join("\n"),
        item.status === "failed",
      );
    case "subagent":
      return toolRoundTrip(
        item,
        "subagent",
        { prompt: item.prompt },
        item.result ?? item.progress ?? "",
        item.status === "failed",
      );
    case "user_input_request": {
      const details = answerDetails(item);
      if (details === undefined) return [];
      return toolRoundTrip(
        item,
        "ask_user_question",
        { questions: item.questions.map((question) => question.question) },
        "User answered.",
        false,
        details,
      );
    }
    default:
      return [];
  }
}

/**
 * A thread's conversation as the Pi session Blackhole reads: one message entry per Pi message,
 * a compaction entry per compaction, and each stored memory record after the item it was
 * written at. A record whose item is gone (a rollback) goes with it, as Pi's branch would.
 */
export function buildSession(input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** In ledger order: inherited records first, oldest ancestor first. */
  readonly records: ReadonlyArray<StoredMemoryRecord>;
}): { readonly entries: SessionEntry[]; readonly lastItemId: string | undefined } {
  const recordsByAnchor = new Map<string, StoredMemoryRecord[]>();
  for (const record of input.records) {
    const anchored = recordsByAnchor.get(record.anchorItemId) ?? [];
    anchored.push(record);
    recordsByAnchor.set(record.anchorItemId, anchored);
  }
  const entries: SessionEntry[] = [];
  let lastItemId: string | undefined;
  for (const item of input.items) {
    const at = iso(item.startedAt) ?? DateTime.formatIso(item.updatedAt);
    if (item.type === "compaction") {
      entries.push({
        type: "compaction",
        id: entryIdOf(item.id),
        timestamp: at,
        summary: item.summary ?? "",
        firstKeptEntryId: "",
      });
    } else {
      const messages = messagesOf(item);
      messages.forEach((message, index) =>
        entries.push({
          type: "message",
          id: entryIdOf(item.id, index === 0 ? "" : `:${index}`),
          timestamp: at,
          message,
        }),
      );
    }
    lastItemId = item.id;
    for (const record of recordsByAnchor.get(item.id) ?? []) {
      entries.push({
        type: "custom",
        id:
          record.inheritedFrom === undefined
            ? `memory-${record.seq}`
            : `memory-${entryIdOf(record.inheritedFrom)}-${record.seq}`,
        timestamp: record.createdAt,
        customType: record.customType,
        data: record.data,
      });
    }
  }
  return { entries, lastItemId };
}
