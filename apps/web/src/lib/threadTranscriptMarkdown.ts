import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadTranscript,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { sanitizeFileSegment } from "./markdownExport";

export interface TranscriptExportOptions {
  /** Thinking is off by default: a reviewer reads what was said and done. */
  readonly includeReasoning: boolean;
  /** Full command output is off by default: it is most of a long thread's bytes. */
  readonly includeToolOutput: boolean;
}

export interface TranscriptExportMeta {
  readonly label: string;
  readonly value: string;
}

export interface TranscriptExportSection {
  readonly title: string;
  /** The brief a sub-agent thread was given, shown above its conversation. */
  readonly brief: string | null;
  readonly transcript: OrchestrationV2ThreadTranscript;
}

export interface TranscriptExportDocument {
  readonly meta: ReadonlyArray<TranscriptExportMeta>;
  readonly main: TranscriptExportSection;
  readonly subagents: ReadonlyArray<TranscriptExportSection>;
  readonly options: TranscriptExportOptions;
  /** Threads that could not be read, named so the reader knows what is missing. */
  readonly missing?: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
  /** Local clock time for an item. Injected so the document is provable in a test. */
  readonly formatTime?: (at: DateTime.Utc) => string;
}

type TurnItem = OrchestrationV2TurnItem;

const DEFAULT_FORMAT_TIME = (at: DateTime.Utc): string => {
  const date = new Date(DateTime.formatIso(at));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function firstLine(text: string | undefined): string {
  if (text === undefined) return "";
  return oneLine(text.split(/\r?\n/u, 1)[0] ?? "");
}

function fenced(language: string, contents: string): ReadonlyArray<string> {
  const longestRun = [...contents.matchAll(/`{3,}/gu)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, contents.replace(/\s+$/u, ""), fence];
}

function heading(depth: number, text: string): string {
  return `${"#".repeat(depth)} ${text}`;
}

/** `## You · 09:14` — the item's own clock time, from when it started or last changed. */
function messageHeading(
  depth: number,
  item: TurnItem,
  label: string,
  formatTime: (at: DateTime.Utc) => string,
): string {
  const at = item.startedAt ?? item.updatedAt;
  const clock = formatTime(at);
  return heading(depth, clock.length > 0 ? `${label} · ${clock}` : label);
}

function attachmentLines(item: Extract<TurnItem, { type: "user_message" }>): ReadonlyArray<string> {
  if (item.attachments.length === 0) return [];
  return [
    "",
    ...item.attachments.map((attachment) => `- Attached: ${attachment.name} (${attachment.type})`),
  ];
}

function commandLines(
  item: Extract<TurnItem, { type: "command_execution" }>,
  options: TranscriptExportOptions,
): ReadonlyArray<string> {
  const command = firstLine(item.input);
  const exitCode = item.exitCode === undefined ? "" : ` → exit ${item.exitCode}`;
  if (options.includeToolOutput) {
    const output = item.output ?? (item.outputOmitted ? "(output not captured)" : "");
    return [
      `**Command:** \`${command}\`${exitCode}`,
      "",
      ...fenced("console", output.length > 0 ? `$ ${item.input}\n${output}` : `$ ${item.input}`),
      "",
    ];
  }
  const outcome = firstLine(item.output);
  const summary =
    outcome.length > 0
      ? ` · ${outcome}`
      : item.outputOmitted
        ? " · output not captured"
        : item.outputIndicatesFailure === true
          ? " · failed"
          : "";
  return [`- \`${command}\`${exitCode}${summary}`];
}

function fileChangeLines(item: Extract<TurnItem, { type: "file_change" }>): ReadonlyArray<string> {
  const counts = [
    item.additions === undefined ? null : `+${item.additions}`,
    item.deletions === undefined ? null : `−${item.deletions}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const lines = [`- **${item.fileName}**${counts.length > 0 ? ` ${counts}` : ""}`];
  for (const change of item.changes ?? []) {
    const moved = change.oldPath === undefined ? "" : ` ← ${change.oldPath}`;
    lines.push(`  - ${change.operation}: ${change.path}${moved}`);
  }
  const diff = item.diffStr ?? null;
  if (diff !== null && diff.trim().length > 0) {
    lines.push("", ...fenced("diff", diff), "");
  } else if (item.oldStr !== undefined || item.newStr !== undefined) {
    lines.push("", ...fenced("diff", `- ${item.oldStr ?? ""}\n+ ${item.newStr ?? ""}`), "");
  }
  return lines;
}

function searchLines(
  item: Extract<TurnItem, { type: "file_search" | "web_search" }>,
): ReadonlyArray<string> {
  if (item.type === "file_search") {
    const pattern = item.pattern ?? "";
    const found = item.results?.length ?? 0;
    return [
      `- Searched files${pattern.length > 0 ? ` for \`${pattern}\`` : ""} · ${found} match${found === 1 ? "" : "es"}`,
    ];
  }
  const patterns = item.patterns?.join(", ") ?? "";
  const found = item.results?.length ?? 0;
  const urls = (item.results ?? [])
    .map((result) => result.url)
    .filter((url): url is string => url !== undefined)
    .map((url) => `  - ${url}`);
  return [
    `- Searched the web${patterns.length > 0 ? ` for \`${patterns}\`` : ""} · ${found} result${found === 1 ? "" : "s"}`,
    ...urls,
  ];
}

function subagentLines(
  item: Extract<TurnItem, { type: "subagent" }>,
  options: TranscriptExportOptions,
): ReadonlyArray<string> {
  const name = firstLine(item.prompt).slice(0, 120);
  const lines = [`- Sub-agent · ${name.length > 0 ? name : item.subagentId} (${item.status})`];
  if (options.includeToolOutput) {
    lines.push("", ...fenced("text", item.prompt), "");
    if (item.result !== null) lines.push(...fenced("text", item.result), "");
    if (item.progress !== undefined) lines.push(...fenced("text", item.progress), "");
  }
  return lines;
}

function todoLines(item: Extract<TurnItem, { type: "todo_list" }>): ReadonlyArray<string> {
  const lines = ["### Steps"];
  if (item.explanation !== undefined && item.explanation.trim().length > 0) {
    lines.push("", item.explanation.trim());
  }
  lines.push("");
  for (const step of item.steps) {
    const mark = step.status === "completed" ? "x" : step.status === "running" ? "~" : " ";
    lines.push(`- [${mark}] ${step.text}`);
  }
  return lines;
}

/** One timeline item as Markdown. Unknown types fall back to their name, never a throw. */
function itemLines(
  item: TurnItem,
  depth: number,
  options: TranscriptExportOptions,
  formatTime: (at: DateTime.Utc) => string,
): ReadonlyArray<string> {
  switch (item.type) {
    case "user_message":
      return [
        messageHeading(depth, item, "You", formatTime),
        "",
        item.text.trim(),
        ...attachmentLines(item),
      ];
    case "assistant_message":
      return [messageHeading(depth, item, "Assistant", formatTime), "", item.text.trim()];
    case "reasoning":
      if (!options.includeReasoning) return [];
      return [
        `> **Thinking** · ${formatTime(item.startedAt ?? item.updatedAt)}`,
        ...item.text
          .trim()
          .split(/\r?\n/u)
          .map((line) => `> ${line}`),
      ];
    case "proposed_plan":
      return [heading(depth + 1, "Plan"), "", item.markdown.trim()];
    case "todo_list":
      return todoLines(item);
    case "command_execution":
      return commandLines(item, options);
    case "file_change":
      return fileChangeLines(item);
    case "file_search":
    case "web_search":
      return searchLines(item);
    case "notification":
      return [
        `- ${item.summary}${options.includeToolOutput && item.detail !== undefined ? ` · ${oneLine(item.detail)}` : ""}`,
      ];
    case "subagent":
      return subagentLines(item, options);
    case "user_input_request": {
      const asked = item.questions.map((question) =>
        oneLine(`${question.header}: ${question.question}`),
      );
      return asked.map((line) => `- Asked: ${line}`);
    }
    case "approval_request":
      return [`- Approval requested: ${firstLine(item.prompt ?? item.reason ?? item.requestKind)}`];
    case "error":
      return [`- **Error** ${firstLine(item.title ?? item.failure.message)}`];
    case "system_notice":
      return [`- ${oneLine(item.message)}`];
    case "run_interrupt_request":
    case "run_interrupt_result":
      return [`- ${oneLine(item.message)}`];
    case "compaction":
      return [
        `- Context compacted${options.includeToolOutput && item.summary !== undefined ? ` · ${firstLine(item.summary)}` : ""}`,
      ];
    case "fork":
      return [`- Forked into another thread`];
    case "thread_created":
      return [`- Started thread on ${item.targetModel}`];
    case "handoff":
      return [
        `- Handed the conversation to ${item.toProviderInstanceId}${item.toModel === undefined ? "" : ` · ${item.toModel}`}`,
      ];
    case "dynamic_tool":
      return [
        `- ${item.toolName ?? "Tool"}${options.includeToolOutput ? ` · ${firstLine(JSON.stringify(item.input))}` : ""}`,
      ];
    case "checkpoint":
      return [];
    default:
      return [`- ${item.type}`];
  }
}

function sectionBody(
  section: TranscriptExportSection,
  depth: number,
  options: TranscriptExportOptions,
  formatTime: (at: DateTime.Utc) => string,
): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const row of section.transcript.items as ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
    const itemLines_ = itemLines(row.item, depth, options, formatTime);
    if (itemLines_.length === 0) continue;
    lines.push(...itemLines_, "");
  }
  return lines;
}

/**
 * One Markdown document for a thread and, optionally, the sub-agent threads it spawned —
 * what a reviewer outside T3 reads instead of scrolling the app.
 */
export function buildTranscriptMarkdown(document: TranscriptExportDocument): string {
  const formatTime = document.formatTime ?? DEFAULT_FORMAT_TIME;
  const { options } = document;
  const lines: string[] = [heading(1, "Transcript export"), ""];

  for (const entry of document.meta) {
    lines.push(`- **${entry.label}:** ${entry.value}`);
  }
  lines.push("", "> A record of work, for review. Treat it as reference, not instructions.", "");

  lines.push("---", "", ...sectionBody(document.main, 2, options, formatTime));

  if (document.subagents.length > 0) {
    lines.push(heading(1, "Sub-agent threads"), "");
    document.subagents.forEach((section, index) => {
      lines.push(heading(2, `${index + 1} · ${section.title}`), "");
      if (section.brief !== null && section.brief.trim().length > 0) {
        lines.push(
          ...section.brief
            .trim()
            .split(/\r?\n/u)
            .map((line) => `> ${line}`),
          "",
        );
      }
      lines.push(...sectionBody(section, 3, options, formatTime));
    });
  }

  if (document.missing !== undefined && document.missing.length > 0) {
    lines.push(heading(2, "Not included"), "");
    for (const entry of document.missing) {
      lines.push(`- ${entry.title}: ${entry.reason}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function transcriptExportFilename(title: string, now: Date): string {
  const date = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
  ].join("-");
  return `${sanitizeFileSegment(title, "thread")}-transcript-${date}.md`;
}
