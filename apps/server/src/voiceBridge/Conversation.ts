// @effect-diagnostics nodeBuiltinImport:off -- A conversation signature is a local content hash used as a map key, not a secret or a platform service.
import * as NodeCrypto from "node:crypto";

/**
 * Turning one OpenAI chat request into one T3 turn.
 *
 * FluidVoice's Command Mode resends the whole conversation on every request, so
 * what a conversation is comes from its history: the system prompt and every
 * message the person and the agent have exchanged. A history the bridge has seen
 * before continues its thread; one it has not starts a new thread rather than
 * guessing which old thread it resembles.
 */

export type ChatContentPart = {
  readonly type: string;
  readonly text?: string | undefined;
};

export type ChatMessage = {
  readonly role: string;
  readonly content: string | ReadonlyArray<ChatContentPart>;
};

const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 64;

/** The text of one message, joining text parts and ignoring anything else. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** The instruction this turn carries: the last thing the person said. */
export function lastUserText(messages: ReadonlyArray<ChatMessage>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    const text = messageText(message);
    if (text !== "") return text;
  }
  return "";
}

/** The last thing the bridge answered, as FluidVoice resends it. */
export function lastAssistantText(messages: ReadonlyArray<ChatMessage>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text !== "") return text;
  }
  return null;
}

/**
 * A conversation's identity is the answer the bridge produced last: FluidVoice
 * resends that answer in the next turn's history, whatever it does with the
 * system prompt or earlier formatting, so the thread is found from the one part
 * of the history the bridge knows it wrote.
 */
export function answerSignature(answer: string): string {
  return NodeCrypto.createHash("sha256").update("answer\u0000").update(answer).digest("hex");
}

/** A thread title from the spoken instruction, so the thread list stays legible. */
export function threadTitle(text: string): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (title === "") return "Voice ask";
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/** Marks where the capture is, so the agent knows the image is the page in question. */
const CAPTURE_NOTE = "The attached screenshot is the window that had focus when I asked.";

/** What the thread is told: the spoken words, and a line about the capture. */
export function turnMessage(text: string, captureAttached: boolean): string {
  return captureAttached ? `${text}\n\n${CAPTURE_NOTE}` : text;
}

/** The closing line that makes the answer openable in T3. */
export function threadLink(threadId: string): string {
  return `t3-thread://v1/${threadId}`;
}
