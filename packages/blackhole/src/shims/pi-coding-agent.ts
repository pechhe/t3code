// From @earendil-works/pi-coding-agent 1.5.2 dist/core/compaction/compaction.js (MIT): the token
// estimates Blackhole's thresholds are tuned against.
import type { Usage } from "./pi-ai.ts";

export type ExtensionAPI = never;

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text") chars += String(block.text ?? "").length;
    else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

export function estimateTokens(message: any): number {
  let chars = 0;
  switch (message?.role) {
    case "user":
    case "custom":
    case "toolResult":
      return Math.ceil(contentChars(message.content) / 4);
    case "assistant":
      for (const block of message.content ?? []) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall")
          chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    case "bashExecution":
      return Math.ceil((message.command.length + message.output.length) / 4);
    case "branchSummary":
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}
