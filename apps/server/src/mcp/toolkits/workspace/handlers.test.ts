import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ExternalWork from "../../../agents/ExternalAgentWorkService.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as Inspection from "../../../workspace/WorkspaceInspection.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorkspaceHandlers from "./handlers.ts";
import { WorkspaceToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:inspection");
const projectId = ProjectId.make("project:inspection");
const ownKey = "a".repeat(64);
const foreignKey = "b".repeat(64);

const sh = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const out = yield* processes.run({
      command: "git",
      args,
      cwd,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    expect(out.code, out.stderr).toBe(0);
  });

const host = (workspacePath: string, access: "read-only" | "peer-threads" | "full-access") =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId,
      requestNamespace: "client:inspection",
      thread: undefined,
      client: { sessionId: "client-session", label: "ChatGPT", access },
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
    }),
    Layer.mock(ExternalWork.ExternalAgentWorkService)({
      // The real service refuses another client's key the same way.
      session: (_scope, key) =>
        key === ownKey
          ? Effect.succeed({
              environmentId,
              projectId,
              workspacePath,
              externalSessionId: "chat",
              key: ownKey,
              clientSessionId: "client-session",
              ceiling: "approval-required",
            })
          : Effect.fail(new ExternalWork.ExternalAgentWorkError({ reason: "session" })),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ id, workspaceRoot: workspacePath } as never)
            : Option.none(),
        ),
    }),
    Layer.effect(Inspection.WorkspaceInspection, Inspection.make),
  ).pipe(Layer.provideMerge(ProcessRunner.layer), Layer.provideMerge(NodeServices.layer));

const outer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const call = <Name extends keyof typeof WorkspaceToolkit.tools & string>(
  name: Name,
  input: unknown,
) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspaceToolkit;
    const results = yield* Stream.runCollect(Stream.unwrap(toolkit.handle(name, input as never)));
    return results.at(-1)?.result as Record<string, unknown>;
  });

const repo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-mcp-" }));
  yield* sh(root, "init", "-q", "-b", "main");
  yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 1;\n");
  yield* fs.writeFileString(`${root}/.env`, "needle=secret\n");
  yield* sh(root, "add", "-A");
  yield* sh(root, "commit", "-q", "-m", "base");
  return root;
});

const run = <A, E, R>(
  root: string,
  access: "read-only" | "peer-threads" | "full-access",
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer).pipe(
        Layer.provideMerge(host(root, access)),
      ),
    ),
  );

it.effect("walks context, search, file, diff and evidence for an attached workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* repo;
      yield* run(
        root,
        "read-only",
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 2;\n");
          const context = yield* call("workspace_read_context", { externalSessionKey: ownKey });
          const token = (context.source as { token: string }).token;
          const search = yield* call("workspace_search", {
            externalSessionKey: ownKey,
            token,
            query: "needle",
          });
          expect((search.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["a.ts"]);
          const file = yield* call("workspace_read_file", {
            externalSessionKey: ownKey,
            token,
            path: "a.ts",
          });
          expect(file.content).toContain("needle = 2");
          const diff = yield* call("workspace_vcs_diff", {
            externalSessionKey: ownKey,
            token,
            scope: "working",
          });
          expect(diff.diff).toContain("+export const needle = 2;");
          const evidence = yield* call("workspace_test_evidence", {
            externalSessionKey: ownKey,
            token,
          });
          expect(evidence).toMatchObject({ evidence: "unavailable", sourceMatch: "none" });
          yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 3;\n");
          const stale = yield* call("workspace_read_file", {
            externalSessionKey: ownKey,
            token,
            path: "a.ts",
          });
          expect(stale).toMatchObject({ message: expect.stringContaining("[stale_source]") });
        }),
      );
    }),
  ).pipe(Effect.provide(outer)),
);

it.effect("refuses a session the calling client does not own without naming the workspace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* repo;
      yield* run(
        root,
        "read-only",
        Effect.gen(function* () {
          const refused = yield* call("workspace_read_context", { externalSessionKey: foreignKey });
          expect(refused).toMatchObject({ code: "capability_denied" });
          expect(JSON.stringify(refused)).not.toContain(root);
        }),
      );
    }),
  ).pipe(Effect.provide(outer)),
);

it.effect("refuses a linked environment even with a valid key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* repo;
      yield* run(
        root,
        "peer-threads",
        Effect.gen(function* () {
          const refused = yield* call("workspace_read_context", { externalSessionKey: ownKey });
          expect(refused).toMatchObject({ code: "capability_denied" });
        }),
      );
    }),
  ).pipe(Effect.provide(outer)),
);

it.effect(
  "refuses once the attached workspace is gone instead of falling back to the project",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const fs = yield* FileSystem.FileSystem;
        yield* run(
          root,
          "read-only",
          Effect.gen(function* () {
            yield* fs.remove(root, { recursive: true });
            yield* fs.makeDirectory(root);
            const refused = yield* call("workspace_read_context", { externalSessionKey: ownKey });
            expect(refused).toMatchObject({
              message: expect.stringContaining("[workspace_unavailable]"),
            });
          }),
        );
      }),
    ).pipe(Effect.provide(outer)),
);
