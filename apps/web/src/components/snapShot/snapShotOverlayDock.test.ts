import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";
import { SNAP_SHOT_TRANSCRIPT_LIMIT, resolveSnapShotOverlayDock } from "./snapShotOverlayDock";

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

const UP = { hidden: false, raisedTurn: null };

describe("resolveSnapShotOverlayDock", () => {
  it("keeps an unsent chat's composer up", () => {
    const dock = resolveSnapShotOverlayDock([], false, UP);
    expect(dock).toMatchObject({ docked: false, prompt: null, reply: null, turn: null });
    expect(resolveSnapShotOverlayDock([], false, { hidden: true, raisedTurn: null }).docked).toBe(
      false,
    );
  });

  it("docks while the agent works and rises with its reply", () => {
    const prompt = message("prompt", "user");
    expect(resolveSnapShotOverlayDock([prompt], true, UP)).toMatchObject({
      docked: true,
      reply: null,
    });
    const reply = message("reply", "assistant");
    expect(resolveSnapShotOverlayDock([prompt, reply], false, UP)).toMatchObject({
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
    const dock = resolveSnapShotOverlayDock(messages, true, UP);
    expect(dock.prompt?.id).toBe("second");
    expect(dock.reply).toBeNull();
  });

  it("lets the user raise the composer for the working turn only", () => {
    const prompt = message("prompt", "user");
    const reply = message("reply", "assistant");
    const working = resolveSnapShotOverlayDock([prompt], true, UP);
    const raised = { hidden: false, raisedTurn: working.turn };
    expect(resolveSnapShotOverlayDock([prompt], true, raised).docked).toBe(false);
    expect(resolveSnapShotOverlayDock([prompt, reply], false, raised).docked).toBe(false);

    // A follow-up is its own turn, docked again.
    const followUp = message("follow-up", "user");
    expect(resolveSnapShotOverlayDock([prompt, reply, followUp], true, raised).docked).toBe(true);
  });

  it("keeps a composer the user put away behind the pill, working or not", () => {
    const prompt = message("prompt", "user");
    const reply = message("reply", "assistant");
    const hidden = { hidden: true, raisedTurn: null };
    expect(resolveSnapShotOverlayDock([prompt], true, hidden).docked).toBe(true);
    expect(resolveSnapShotOverlayDock([prompt, reply], false, hidden).docked).toBe(true);
  });

  it("shows the latest prompts and replies of a long conversation", () => {
    const messages = Array.from({ length: SNAP_SHOT_TRANSCRIPT_LIMIT + 2 }, (_, index) =>
      message(`message-${index}`, index % 2 === 0 ? "user" : "assistant"),
    );
    const dock = resolveSnapShotOverlayDock([message("system", "system"), ...messages], false, UP);
    expect(dock.truncated).toBe(true);
    expect(dock.transcript).toEqual(messages.slice(2));
  });
});
