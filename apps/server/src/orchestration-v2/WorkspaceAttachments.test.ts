import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WorkspaceAttachment,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as WorkspaceAttachments from "./WorkspaceAttachments.ts";

const threadId = ThreadId.make("thread:lead");
const apiProject = ProjectId.make("project:api");
const workspacePath = "/workspaces/api-1";

const attachment = (
  overrides: Partial<OrchestrationV2WorkspaceAttachment> = {},
): OrchestrationV2WorkspaceAttachment => ({
  projectId: apiProject,
  workspacePath,
  branch: null,
  origin: "allocated",
  attachedAt: "2026-10-19T09:00:00.000Z",
  releasedAt: null,
  ...overrides,
});

interface Fixture {
  readonly attachment?: OrchestrationV2WorkspaceAttachment;
  /** The workspace is still a checkout of its project. */
  readonly exists?: boolean;
  readonly landing?: boolean;
  readonly editedFiles?: ReadonlyArray<string>;
  readonly otherThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
}

const layerFor = (
  fixture: Fixture,
  recorded: { dispatched: Array<OrchestrationV2ServerCommand>; removed: Array<string> },
) =>
  WorkspaceAttachments.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              workspaceAttachments: [fixture.attachment ?? attachment()],
            } as unknown as OrchestrationV2ThreadShell),
          listProjectThreads: () => Effect.succeed(fixture.otherThreads ?? []),
          dispatch: (command) =>
            Effect.sync(() => {
              recorded.dispatched.push(command as OrchestrationV2ServerCommand);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo/api" } as never)),
        }),
        Layer.mock(WorkspaceProvider.WorkspaceProvider)({
          contains: () => Effect.succeed(fixture.exists ?? true),
          remove: (input) => Effect.sync(() => void recorded.removed.push(input.path)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.succeed({
              workingTree: {
                files: (fixture.editedFiles ?? []).map((path) => ({
                  path,
                  insertions: 1,
                  deletions: 0,
                })),
              },
            } as never),
        }),
        Layer.mock(SlipJayLandings.SlipJayLandings)({
          isLanding: () => Effect.succeed(fixture.landing ?? false),
        }),
        SqlitePersistence.layerMemory,
        NodeServices.layer,
      ),
    ),
  );

const run = <A, E>(
  fixture: Fixture,
  use: (service: WorkspaceAttachments.WorkspaceAttachments["Service"]) => Effect.Effect<A, E>,
) => {
  const recorded = { dispatched: [] as Array<OrchestrationV2ServerCommand>, removed: [] };
  return WorkspaceAttachments.WorkspaceAttachments.pipe(
    Effect.flatMap((service) => Effect.exit(use(service))),
    Effect.map((exit) => ({ exit, ...recorded })),
    Effect.provide(layerFor(fixture, recorded)),
  );
};

const actions = (dispatched: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  dispatched.map((command) =>
    command.type === "thread.workspace-attachment.update" ? command.change.action : command.type,
  );

it.effect("detaching an allocated workspace releases it, then forgets it", () =>
  Effect.gen(function* () {
    const result = yield* run({}, (service) => service.detach({ threadId, workspacePath }));
    expect(result.exit._tag).toBe("Success");
    expect(result.removed).toEqual([workspacePath]);
    expect(actions(result.dispatched)).toEqual(["detach"]);
  }),
);

it.effect("detaching an adopted checkout leaves it in place", () =>
  Effect.gen(function* () {
    const result = yield* run({ attachment: attachment({ origin: "adopted" }) }, (service) =>
      service.detach({ threadId, workspacePath }),
    );
    expect(result.removed).toEqual([]);
    expect(actions(result.dispatched)).toEqual(["detach"]);
  }),
);

it.effect("refuses to detach a workspace with uncommitted edits, a Land or a writer", () =>
  Effect.gen(function* () {
    const writer = {
      id: "thread:helper",
      worktreePath: workspacePath,
      status: "running",
      lineage: { rootThreadId: threadId },
      agentTask: { workId: "w", sourceAccess: "scoped-write" },
    } as unknown as OrchestrationV2ThreadShell;
    const adopted = attachment({ origin: "adopted" });
    const refusals = yield* Effect.forEach(
      [
        { editedFiles: ["src/api.ts"] },
        { landing: true },
        { otherThreads: [writer] },
        { attachment: adopted, landing: true },
        { attachment: adopted, otherThreads: [writer] },
      ],
      (fixture) => run(fixture, (service) => service.detach({ threadId, workspacePath })),
    );
    expect(
      refusals.map((result) =>
        result.exit._tag === "Failure" ? String(result.exit.cause) : "detached",
      ),
    ).toEqual([
      expect.stringContaining("uncommitted edits: src/api.ts"),
      expect.stringContaining("A Land is running"),
      expect.stringContaining("Another agent is writing"),
      expect.stringContaining("A Land is running"),
      expect.stringContaining("Another agent is writing"),
    ]);
    expect(refusals.flatMap((result) => [...result.removed, ...result.dispatched])).toEqual([]);
  }),
);

it.effect("a turn start records the release of a workspace SlipJay removed", () =>
  Effect.gen(function* () {
    const gone = yield* run({ exists: false }, (service) => service.markReleased(threadId));
    expect(actions(gone.dispatched)).toEqual(["release"]);
    const kept = yield* run({ exists: true }, (service) => service.markReleased(threadId));
    expect(kept.dispatched).toEqual([]);
    // An adopted checkout is never released by SlipJay on the thread's behalf.
    const adopted = yield* run(
      { exists: false, attachment: attachment({ origin: "adopted" }) },
      (service) => service.markReleased(threadId),
    );
    expect(adopted.dispatched).toEqual([]);
  }),
);
