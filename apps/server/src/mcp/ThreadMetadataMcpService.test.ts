import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  BuildWorkItemError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BuildWorkItems from "../hq/BuildWorkItems.ts";

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
  build: Partial<BuildWorkItems.BuildWorkItems["Service"]> = {},
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
      ).pipe(Layer.merge(Layer.mock(BuildWorkItems.BuildWorkItems)(build))),
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
                    new BuildWorkItemError({ reason: "not_found", message: "no such item" }),
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

it.effect("set_workflow keeps the stance the user chose unless the agent sets it", () =>
  Effect.gen(function* () {
    const sent: Array<unknown> = [];
    const setWorkflow = (workflow: { kind: "solo"; unattended?: boolean }) =>
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
              ).pipe(Layer.merge(Layer.mock(BuildWorkItems.BuildWorkItems)({}))),
            ),
          ),
        ),
        Effect.exit,
      );
    yield* setWorkflow({ kind: "solo" });
    yield* setWorkflow({ kind: "solo", unattended: false });
    expect(sent.map((command) => (command as { workflow: unknown }).workflow)).toEqual([
      { kind: "solo", unattended: true },
      { kind: "solo", unattended: false },
    ]);
  }),
);
