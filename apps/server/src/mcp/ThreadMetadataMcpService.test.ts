import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ForgeWorkItemError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  requestNamespace: "provider-session:metadata-test",
  thread: {
    threadId,
    providerSessionId: "provider-session:metadata-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function layerService(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
  build: Partial<ForgeWorkItems.ForgeWorkItems["Service"]> = {},
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
          getProjectThreadRecords: () =>
            Effect.succeed({ thread: { projectId: "project" } } as never),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ).pipe(Layer.merge(Layer.mock(ForgeWorkItems.ForgeWorkItems)(build))),
    ),
  );
}

it.effect("link_work_item hands a friendly ref to Build as written, and reports a refusal", () =>
  Effect.gen(function* () {
    const references: Array<string | null> = [];
    const results = yield* Effect.forEach(["t3-30", "YS-12.1"], (workItem) =>
      Effect.gen(function* () {
        const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
        return yield* service
          .update(scope, { action: "link_work_item", workItem })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layerService(() => Effect.succeed({ projectId: "project", deletedAt: null } as never), {
            link: ({ reference }) =>
              Effect.sync(() => references.push(reference)).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new ForgeWorkItemError({ reason: "not_found", message: "no such item" }),
                  ),
                ),
              ),
          }),
        ),
      ),
    );
    expect(references).toEqual(["t3-30", "YS-12.1"]);
    expect(results.map((error) => error.code)).toEqual(["invalid_request", "invalid_request"]);
  }),
);

it.effect("arc_run dispatches for the caller's own thread and refuses any other", () =>
  Effect.gen(function* () {
    const sent: Array<{ readonly type: string; readonly op?: string; readonly arc?: unknown }> = [];
    const layer = ThreadMetadataMcp.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ projectId: "project", deletedAt: null } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({ thread: { projectId: "project" } } as never),
            dispatch: (command) =>
              Effect.sync(() => sent.push(command as never)).pipe(
                Effect.flatMap(() => Effect.die("stop after capturing the command")),
              ),
          } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
          NodeCrypto.layer,
        ).pipe(Layer.merge(Layer.mock(ForgeWorkItems.ForgeWorkItems)({}))),
      ),
    );
    const update = (
      input: Parameters<ThreadMetadataMcp.ThreadMetadataMcpService["Service"]["update"]>[1],
    ) =>
      Effect.gen(function* () {
        const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }).pipe(Effect.provide(layer));

    yield* update({
      action: "arc_run",
      arcRun: { op: "start", arc: 12, ref: "YS-ARC-12" },
    }).pipe(Effect.exit);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "thread.arc-run",
      op: "start",
      arc: { number: 12, ref: "YS-ARC-12" },
    });

    const refused = yield* update({
      action: "arc_run",
      threadId: ThreadId.make("thread:someone-else"),
      arcRun: { op: "pause" },
    }).pipe(Effect.flip);
    expect(refused.code).toBe("capability_denied");
    expect(sent).toHaveLength(1);
  }),
);

it.effect("set_workflow records no per-thread stance, even when an agent passes one", () =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const setWorkflow = (workflow: { kind: "solo" }) =>
      Effect.gen(function* () {
        const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
        yield* service.update(scope, { action: "set_workflow", workflow }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          ThreadMetadataMcp.layer.pipe(
            Layer.provide(
              Layer.merge(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadShell: () =>
                    Effect.succeed({ projectId: "project", deletedAt: null } as never),
                  getProjectThreadRecords: () =>
                    Effect.succeed({
                      thread: {
                        projectId: "project",
                        workflow: { kind: "lead", unattended: true },
                      },
                    } as never),
                  dispatch: (command) =>
                    Effect.sync(() => sent.push(command)).pipe(
                      Effect.flatMap(() => Effect.die("stop after capturing the command")),
                    ),
                } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
                NodeCrypto.layer,
              ).pipe(Layer.merge(Layer.mock(ForgeWorkItems.ForgeWorkItems)({}))),
            ),
          ),
        ),
        Effect.exit,
      );
    yield* setWorkflow({ kind: "solo" });
    // A stale agent instruction may still send the retired field.
    yield* setWorkflow({ kind: "solo", unattended: true } as { kind: "solo" });
    expect(sent.map((command) => (command as { workflow: unknown }).workflow)).toEqual([
      { kind: "solo", unattended: false },
      { kind: "solo", unattended: false },
    ]);
  }),
);
