/**
 * The OpenAI chat-completion stream FluidVoice reads.
 *
 * It is written by hand rather than with a framework because the contract is
 * three shapes wide: one role chunk, the text deltas, and a final chunk that
 * carries `finish_reason` before `[DONE]`.
 */

export type CompletionChunk = {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly delta: { readonly role?: "assistant"; readonly content?: string };
    readonly finish_reason: "stop" | null;
  }>;
};

export function roleChunk(id: string, created: number, model: string): CompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

export function textChunk(id: string, created: number, model: string, content: string): CompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

export function stopChunk(id: string, created: number, model: string): CompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

/** One server-sent event carrying `payload`. */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
