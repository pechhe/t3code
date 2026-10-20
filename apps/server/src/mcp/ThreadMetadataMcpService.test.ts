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

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
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

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(layerService(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        layerService(() =>
          Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

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
