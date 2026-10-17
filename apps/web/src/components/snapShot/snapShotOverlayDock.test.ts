import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import { resolveSnapShotOverlayDock } from "./snapShotOverlayDock";

function message(id: string, role: ChatMessage["role"], text = id): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    runId: null,
    streaming: false,
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:00.000Z",
  };
}

describe("resolveSnapShotOverlayDock", () => {
  it("keeps an unsent chat's composer up", () => {
    const dock = resolveSnapShotOverlayDock([], false, null);
    expect(dock).toMatchObject({ docked: false, prompt: null, reply: null, phase: null });
  });

  it("docks while the agent works and rises with its reply", () => {
    const prompt = message("prompt", "user");
    expect(resolveSnapShotOverlayDock([prompt], true, null)).toMatchObject({
      docked: true,
      reply: null,
    });
    const reply = message("reply", "assistant");
    expect(resolveSnapShotOverlayDock([prompt, reply], false, null)).toMatchObject({
      docked: false,
      prompt,
      reply,
    });
  });

  it("answers only the latest prompt", () => {
    const messages = [
      message("first", "user"),
      message("first-reply", "assistant"),
      message("second", "user"),
    ];
    const dock = resolveSnapShotOverlayDock(messages, true, null);
    expect(dock.prompt?.id).toBe("second");
    expect(dock.reply).toBeNull();
  });

  it("lets the user raise or tuck the composer for the current turn only", () => {
    const prompt = message("prompt", "user");
    const reply = message("reply", "assistant");
    const working = resolveSnapShotOverlayDock([prompt], true, null);
    expect(resolveSnapShotOverlayDock([prompt], true, working.phase).docked).toBe(false);

    // The raise was for the working turn; the reply arrives up as usual.
    const answered = resolveSnapShotOverlayDock([prompt, reply], false, working.phase);
    expect(answered.docked).toBe(false);
    expect(resolveSnapShotOverlayDock([prompt, reply], false, answered.phase).docked).toBe(true);

    // A follow-up starts its own turn, docked again.
    const followUp = message("follow-up", "user");
    expect(resolveSnapShotOverlayDock([prompt, reply, followUp], true, answered.phase).docked).toBe(
      true,
    );
  });
});
