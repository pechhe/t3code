import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ExperimentService from "./ExperimentService.ts";
import * as InstructionOverlay from "./InstructionOverlay.ts";

const assignment = {
  experimentId: "instructions",
  lever: "instruction",
  unitKind: "thread",
  assignmentMethod: "randomized",
  variant: {
    id: "terse",
    label: "Terse",
    instructions: {
      sourcePath: "skills/lead/SKILL.md",
      revision: "agent-config:abc123",
      text: "Keep each reply under five lines.",
      sha256: "9f2e399e91eddf0580cfa032b906deeb5cd0e1f966f6277c566fbe161f8b818c",
    },
  },
};

const forRun = (runId: string, driver = "codex") =>
  Effect.gen(function* () {
    const overlay = yield* InstructionOverlay.InstructionOverlay;
    return yield* overlay.forRun({
      runId: RunId.make(runId),
      thread: {
        id: ThreadId.make("thread:overlay"),
        projectId: ProjectId.make("project:overlay"),
        createdAt: DateTime.makeUnsafe("2998-01-01T00:00:00Z"),
      },
      modelSelection: { instanceId: ProviderInstanceId.make(driver), model: "gpt-5.4" },
      driver,
    });
  });

it.effect("decides each run's overlay once, so every reader sees what the run was sent", () => {
  let lookups = 0;
  return Effect.gen(function* () {
    // The first lookup fails: the run gets no overlay, and a later reader of the same run
    // (its setup record) sees none either, though the experiment is now reachable.
    assert.isNull(yield* forRun("run:1"));
    assert.isNull(yield* forRun("run:1"));
    assert.strictEqual(lookups, 1);
    const [delivered, recorded] = yield* Effect.all([forRun("run:2"), forRun("run:2")], {
      concurrency: "unbounded",
    });
    assert.strictEqual(delivered?.sha256, assignment.variant.instructions.sha256);
    assert.deepStrictEqual(recorded, delivered);
    assert.strictEqual(lookups, 2);
    // Providers that cannot deliver an overlay are never enrolled.
    assert.isNull(yield* forRun("run:3", "cursor"));
    assert.strictEqual(lookups, 2);
  }).pipe(
    Effect.provide(
      InstructionOverlay.layer.pipe(
        Layer.provide(
          Layer.mock(ExperimentService.ExperimentService)({
            assignForThread: () =>
              Effect.suspend(() =>
                ++lookups === 1
                  ? Effect.die("experiment store unavailable")
                  : Effect.succeed([assignment] as never),
              ),
          }),
        ),
      ),
    ),
  );
});
