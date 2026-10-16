import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ContextRolloverNotes,
  ROLLOVER_NOTE_MAX_BYTES,
  ROLLOVER_NOTE_RECIPE,
  assignedRolloverThresholds,
} from "./ContextRollover.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";

export class RolloverNoteError extends Schema.TaggedError<RolloverNoteError>()(
  "RolloverNoteError",
  {
    reason: Schema.Literals(["invalid_request", "run_not_found", "capability_denied", "operation"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ContextRolloverNoteService extends Context.Service<
  ContextRolloverNoteService,
  {
    readonly submit: (input: {
      readonly threadId: ThreadId;
      readonly note: string;
    }) => Effect.Effect<void, RolloverNoteError>;
  }
>()("t3/orchestration-v2/ContextRolloverNoteService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const threads = yield* Threads.ThreadManagementService;
  const experiments = yield* Experiments.ExperimentService;
  const crypto = yield* Crypto.Crypto;
  const notes = yield* ContextRolloverNotes;
  return ContextRolloverNoteService.of({
    submit: Effect.fn("ContextRolloverNoteService.submit")(function* (input) {
      const { threadId, note } = input;
      const bytes = Buffer.byteLength(note, "utf8");
      if (bytes > ROLLOVER_NOTE_MAX_BYTES)
        return yield* new RolloverNoteError({
          reason: "invalid_request",
          message: `The note is ${bytes.toLocaleString("en-US")} bytes; the fresh session can take ${ROLLOVER_NOTE_MAX_BYTES.toLocaleString("en-US")}. Shorten it (point to files and issues instead of copying them) and call again; nothing was saved.`,
        });
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new RolloverNoteError({
              reason: "operation",
              message: "Unable to save the context rollover note.",
              cause,
            }),
        ),
      );
      const { thread, runs } = yield* threads.getThreadProjection(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new RolloverNoteError({
              reason: "operation",
              message: "Unable to save the context rollover note.",
              cause,
            }),
        ),
      );
      const run = runs.findLast(
        (candidate) => candidate.status === "running" || candidate.status === "waiting",
      );
      if (run === undefined)
        return yield* new RolloverNoteError({
          reason: "run_not_found",
          message: "This thread has no running turn to hand off from.",
        });
      const assignment = yield* experiments.getRolloverAssignment(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new RolloverNoteError({
              reason: "operation",
              message: "Unable to save the context rollover note.",
              cause,
            }),
        ),
      );
      if (
        assignedRolloverThresholds(
          settings.contextRollover,
          thread,
          run.modelSelection.model,
          assignment?.variant.rollover,
        ) === null
      )
        return yield* new RolloverNoteError({
          reason: "capability_denied",
          message: "Context rollover is off for this thread. Continue normally; nothing was saved.",
        });
      if (assignment !== null) {
        const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(note)).pipe(
          Effect.mapError(
            (cause) =>
              new RolloverNoteError({
                reason: "operation",
                message: "Unable to save the context rollover note.",
                cause,
              }),
          ),
        );
        yield* experiments
          .recordEvidence({
            id: `rollover-note:${assignment.id}:${run.id}:${Buffer.from(digest).toString("hex")}`,
            assignmentId: assignment.id,
            episodeId: `rollover:${assignment.id}:${run.id}`,
            recipeRevision: ROLLOVER_NOTE_RECIPE,
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
          .pipe(
            Effect.mapError(
              (cause) =>
                new RolloverNoteError({
                  reason: "operation",
                  message: "Unable to save the context rollover note.",
                  cause,
                }),
            ),
          );
      }
      notes.save(threadId, { runId: run.id, note });
    }),
  });
});
export const layer = Layer.effect(ContextRolloverNoteService, make);
