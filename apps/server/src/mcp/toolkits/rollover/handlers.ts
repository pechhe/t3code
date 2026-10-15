import * as Crypto from "effect/Crypto";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ContextRolloverNotes,
  ROLLOVER_NOTE_MAX_BYTES,
  assignedRolloverThresholds,
} from "../../../orchestration-v2/ContextRollover.ts";
import * as ExperimentService from "../../../experiments/ExperimentService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { RolloverToolkit } from "./tools.ts";

const handlers = {
  t3_write_rollover_note: McpToolAccess.readsAsCaller(({ note }) =>
    Effect.gen(function* () {
      const { thread: caller } = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "t3_write_rollover_note",
      );
      const threadId = caller.threadId;
      const bytes = Buffer.byteLength(note, "utf8");
      if (bytes > ROLLOVER_NOTE_MAX_BYTES)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `The note is ${bytes.toLocaleString("en-US")} bytes; the fresh session can take ${ROLLOVER_NOTE_MAX_BYTES.toLocaleString("en-US")}. Shorten it (point to files and issues instead of copying them) and call again; nothing was saved.`,
        });
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(unavailable),
      );
      const { thread, runs } = yield* (yield* ThreadManagementService.ThreadManagementService)
        .getThreadProjection(threadId)
        .pipe(Effect.mapError(unavailable));
      const run = runs.findLast(
        (candidate) => candidate.status === "running" || candidate.status === "waiting",
      );
      if (run === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "run_not_found",
          message: "This thread has no running turn to hand off from.",
        });
      const assignment = yield* (yield* ExperimentService.ExperimentService)
        .getRolloverAssignment(threadId)
        .pipe(Effect.mapError(unavailable));
      if (
        assignedRolloverThresholds(
          settings.contextRollover,
          thread,
          run.modelSelection.model,
          assignment?.variant.rollover,
        ) === null
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Context rollover is off for this thread. Continue normally; nothing was saved.",
        });
      if (assignment !== null) {
        const digest = yield* (yield* Crypto.Crypto)
          .digest("SHA-256", new TextEncoder().encode(note))
          .pipe(Effect.mapError(unavailable));
        yield* (yield* ExperimentService.ExperimentService)
          .recordEvidence({
            id: `rollover-note:${assignment.id}:${run.id}:${Buffer.from(digest).toString("hex")}`,
            assignmentId: assignment.id,
            episodeId: `rollover:${assignment.id}:${run.id}`,
            recipeRevision: "rollover-v1",
            runId: run.id,
            phase: "action",
            source: "agent",
            artifacts: Array.from({ length: Math.ceil(note.length / 16_000) }, (_, index) => ({
              kind: "submitted-handoff-note",
              reference: `run:${run.id}:note-offset:${index * 16_000}`,
              content: note.slice(index * 16_000, (index + 1) * 16_000),
            })),
            missing: [],
          })
          .pipe(Effect.mapError(unavailable));
      }
      (yield* ContextRolloverNotes).save(threadId, { runId: run.id, note });
      return {
        message:
          "Saved. End your turn now with one short line at most; the thread continues on a fresh session seeded with this note.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RolloverToolkit.tools>;

export const layer = McpToolAccess.toLayer(RolloverToolkit, handlers);
