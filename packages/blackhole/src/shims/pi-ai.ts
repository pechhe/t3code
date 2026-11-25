// Stand-ins for the @earendil-works/pi-ai types and helpers Blackhole's vendored code imports.
// T3 never runs pi-ai: transcripts are converted into these shapes (see ../transcript.ts).
export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: unknown;
}
export interface UserMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export interface SystemMessage {
  role: "system";
  content: string;
}
export interface Tool {
  name: string;
  description: string;
  parameters: unknown;
}
export type Model<_Api = unknown> = {
  id: string;
  provider: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: unknown;
};
export type CacheRetention = "none" | "short" | "long";
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// From pi-ai 1.5.2 dist/utils/overflow.js (MIT): the error-message arm only.
const OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /prompt exceeds max length/i, // z.ai CN endpoint token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /context window exceeded/i, // LiteLLM pre-call check (ContextWindowExceededError)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  // HTTP 413 means request-size overflow regardless of provider or body text.
  // Match raw SDK errors and formatProviderError's prefix, not a status mentioned in the body.
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];
export function isContextOverflow(message: {
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly [key: string]: unknown;
}): boolean {
  const text = message.errorMessage;
  if (message.stopReason !== "error" || !text) return false;
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
