// Stand-ins for the @earendil-works/pi-agent-core shapes Blackhole's workers use. T3 always
// passes its own agentLoop (../worker.ts), so the default here is never reached.
import type { Message, SystemMessage } from "./pi-ai.ts";

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  terminate?: boolean;
}
export interface AgentTool<TParams = any> {
  name: string;
  label?: string;
  description: string;
  parameters: TParams;
  execute: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<AgentToolResult>;
}
export interface AgentContext {
  systemPrompt?: string;
  messages: Array<Message | SystemMessage>;
  tools: AgentTool<any>[];
}
export interface AgentLoopConfig {
  convertToLlm?: (messages: any[]) => Message[];
  [key: string]: any;
}
export type AgentTurnDecision = { action: "end" };
export interface AgentEventStream extends AsyncIterable<{ type: string; messages?: unknown[] }> {
  result: () => Promise<unknown>;
}
export type AgentLoop = (
  prompts: Message[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: unknown,
) => AgentEventStream;

export const agentLoop: AgentLoop = () => {
  throw new Error("Blackhole workers in T3 need T3's agentLoop.");
};
