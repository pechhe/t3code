import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as OrchestratorHandlers from "../orchestrator/handlers.ts";
import * as ThreadHandlers from "../thread/handlers.ts";
import { pickThreadUpdate } from "./handlers.ts";

it.effect("sends each action to the tool whose work it does, with that tool's input", () =>
  Effect.gen(function* () {
    const cases = [
      [
        { action: "rename", title: "New" },
        OrchestratorHandlers.handlers.t3_thread_update,
        { action: "rename", title: "New" },
      ],
      [{ action: "settle" }, ThreadHandlers.handlers.t3_thread_organize, { action: "settle" }],
      [
        { action: "snooze", snoozedUntil: "2026-12-01T09:00:00.000Z" },
        ThreadHandlers.handlers.t3_thread_organize,
        { action: "snooze" },
      ],
      [{ action: "configure" }, ThreadHandlers.handlers.t3_thread_configure, {}],
      [
        { action: "move_to_project", projectId: "project" },
        ThreadHandlers.handlers.t3_thread_move_to_project,
        { projectId: "project" },
      ],
      [
        { action: "suggest_project", projectId: "project", reason: "It is that app" },
        ThreadHandlers.handlers.t3_thread_suggest_project,
        { projectId: "project", reason: "It is that app" },
      ],
      [{ action: "transfers" }, ThreadHandlers.handlers.t3_thread_transfer, { action: "status" }],
      [
        { action: "merge_back", targetThreadId: "parent" },
        ThreadHandlers.handlers.t3_thread_transfer,
        { action: "merge_back", targetThreadId: "parent" },
      ],
    ] as const;
    for (const [params, declaration, input] of cases) {
      const routed = yield* pickThreadUpdate(params);
      expect(routed.declaration, params.action).toBe(declaration);
      expect(routed.params, params.action).toMatchObject(input);
    }
  }),
);

it.effect("refuses fields its action does not take, and input that tool would refuse", () =>
  Effect.gen(function* () {
    const message = (params: Parameters<typeof pickThreadUpdate>[0]) =>
      pickThreadUpdate(params).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
    expect(yield* message({ action: "pin", title: "x" })).toContain("pin does not take title");
    expect(yield* message({ action: "rename" })).toContain("rename requires title");
    expect(yield* message({ action: "move_to_project" })).toContain("projectId");
  }),
);
