import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as ExternalWork from "../agents/ExternalAgentWorkService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "../project/ProjectService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * The same registry and dispatch an external OAuth client reaches through `/mcp`: tools are
 * registered by the production layer and called by name with JSON arguments. The credential
 * (client scope, no thread) is what the OAuth middleware hands each request.
 */
const environmentId = EnvironmentId.make("environment:inspection-smoke");
const projectId = ProjectId.make("project:inspection-smoke");
const ownKey = "c".repeat(64);
const foreignKey = "d".repeat(64);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "chatgpt", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "chatgpt", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const credential = (access: "read-only" | "peer-threads") =>
  ({
    environmentId,
    requestNamespace: "client:smoke",
    thread: undefined,
    client: { sessionId: "smoke-session", label: "ChatGPT", access },
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  }) satisfies McpInvocationContext.McpInvocationScope;

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const out = yield* (yield* ProcessRunner.ProcessRunner).run({
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

const jj = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const out = yield* (yield* ProcessRunner.ProcessRunner).run({ command: "jj", args, cwd });
    expect(out.code, out.stderr).toBe(0);
    return out.stdout;
  });

const fingerprint = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = (yield* fs.readDirectory(root, { recursive: true })).toSorted();
    const parts: string[] = [];
    for (const entry of entries) {
      const info = yield* fs.stat(`${root}/${entry}`);
      parts.push(
        info.type === "File"
          ? `${entry}:${(yield* fs.readFile(`${root}/${entry}`)).length}:${info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0}`
          : entry,
      );
    }
    return parts.join("\n");
  });

const layerFor = (workspacePath: string) =>
  McpHttpServer.layerWorkspaceInspectionToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ExternalWork.ExternalAgentWorkService)({
          session: (_scope, key) =>
            key === ownKey
              ? Effect.succeed({
                  environmentId,
                  projectId,
                  workspacePath,
                  externalSessionId: "chat",
                  key: ownKey,
                  clientSessionId: "smoke-session",
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
        ProcessRunner.layer,
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const outer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const callAs = (access: "read-only" | "peer-threads", name: string, args: object) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args as never })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, credential(access)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

const structured = (result: { readonly structuredContent?: unknown }) =>
  result.structuredContent as Record<string, any>;

it.effect(
  "walks context, search, file, diff and evidence over the MCP registry without writes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-smoke-" }),
        );
        yield* git(root, "init", "-q", "-b", "main");
        yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 1;\n");
        yield* git(root, "add", "-A");
        yield* git(root, "commit", "-q", "-m", "base");
        yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 2;\n");
        const before = yield* fingerprint(root);

        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
            "workspace_read_context",
            "workspace_read_file",
            "workspace_search",
            "workspace_test_evidence",
            "workspace_vcs_diff",
            "workspace_vcs_log",
            "workspace_vcs_status",
          ]);
          const context = structured(
            yield* callAs("read-only", "workspace_read_context", { externalSessionKey: ownKey }),
          );
          const token = context.source.token as string;
          expect(context.changes).toEqual([{ path: "a.ts", status: "M", recordedIn: "vcs" }]);
          const search = structured(
            yield* callAs("read-only", "workspace_search", {
              externalSessionKey: ownKey,
              token,
              query: "needle",
            }),
          );
          expect(search.matches).toEqual([
            { path: "a.ts", line: 1, text: "export const needle = 2;" },
          ]);
          const file = structured(
            yield* callAs("read-only", "workspace_read_file", {
              externalSessionKey: ownKey,
              token,
              path: "a.ts",
            }),
          );
          expect(file.content).toContain("needle = 2");
          const diff = structured(
            yield* callAs("read-only", "workspace_vcs_diff", {
              externalSessionKey: ownKey,
              token,
              scope: "working",
            }),
          );
          expect(diff.diff).toContain("+export const needle = 2;");
          const evidence = structured(
            yield* callAs("read-only", "workspace_test_evidence", {
              externalSessionKey: ownKey,
              token,
            }),
          );
          expect(evidence).toMatchObject({ evidence: "unavailable", sourceMatch: "none" });
          expect(yield* fingerprint(root)).toBe(before);

          // Another client's key, a linked environment, a concurrent change and a removed workspace.
          const foreign = yield* callAs("read-only", "workspace_read_context", {
            externalSessionKey: foreignKey,
          });
          expect(foreign.isError).toBe(true);
          expect(JSON.stringify(foreign)).not.toContain(root);
          const peer = yield* callAs("peer-threads", "workspace_read_context", {
            externalSessionKey: ownKey,
          });
          expect(peer.isError).toBe(true);
          yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 3;\n");
          const stale = yield* callAs("read-only", "workspace_read_file", {
            externalSessionKey: ownKey,
            token,
            path: "a.ts",
          });
          expect(stale.isError).toBe(true);
          expect(JSON.stringify(stale)).toContain("stale_source");
          yield* fs.remove(root, { recursive: true });
          yield* fs.makeDirectory(root);
          const gone = yield* callAs("read-only", "workspace_read_context", {
            externalSessionKey: ownKey,
          });
          expect(JSON.stringify(gone)).toContain("workspace_unavailable");
        }).pipe(Effect.provide(layerFor(root)));
      }),
    ).pipe(Effect.provide(outer)),
);

it.effect("reads a jj workspace over the same registry without snapshotting it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-jj-smoke-" }),
      );
      yield* jj(root, "git", "init", ".");
      yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 1;\n");
      yield* jj(root, "commit", "-m", "base");
      const revision = (yield* jj(root, "log", "-r", "@", "--no-graph", "-T", "commit_id")).trim();
      yield* fs.writeFileString(`${root}/a.ts`, "export const needle = 2;\n");
      const before = yield* fingerprint(root);

      yield* Effect.gen(function* () {
        const context = structured(
          yield* callAs("read-only", "workspace_read_context", { externalSessionKey: ownKey }),
        );
        const token = context.source.token as string;
        // No snapshot on read: the edit stays a disk observation against the last recorded revision.
        expect(context.source.vcs).toBe("jj");
        expect(context.source.revision).toBe(revision);
        expect(context.changes).toEqual([{ path: "a.ts", status: "M", recordedIn: "disk" }]);
        const status = structured(
          yield* callAs("read-only", "workspace_vcs_status", { externalSessionKey: ownKey, token }),
        );
        expect(status.changes).toEqual([{ path: "a.ts", status: "M", recordedIn: "disk" }]);
        const log = structured(
          yield* callAs("read-only", "workspace_vcs_log", { externalSessionKey: ownKey, token }),
        );
        expect(log.entries.map((entry: { summary: string }) => entry.summary)).toContain("base");
        const search = structured(
          yield* callAs("read-only", "workspace_search", {
            externalSessionKey: ownKey,
            token,
            query: "needle",
          }),
        );
        expect(search.matches).toEqual([
          { path: "a.ts", line: 1, text: "export const needle = 2;" },
        ]);
        const file = structured(
          yield* callAs("read-only", "workspace_read_file", {
            externalSessionKey: ownKey,
            token,
            path: "a.ts",
          }),
        );
        expect(file.content).toContain("needle = 2");
        const diff = structured(
          yield* callAs("read-only", "workspace_vcs_diff", {
            externalSessionKey: ownKey,
            token,
            scope: "working",
          }),
        );
        expect(diff.diff).toContain("+export const needle = 2;");
        expect(yield* fingerprint(root)).toBe(before);
      }).pipe(Effect.provide(layerFor(root)));
    }),
  ).pipe(Effect.provide(outer)),
);
