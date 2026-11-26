// @effect-diagnostics nodeBuiltinImport:off - Test fixture stands up a local stub HTTP MCP server.
import * as NodeHTTP from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as WebResearch from "./WebResearch.ts";

const startStub = (mode: "success" | "auth" | "malformed") =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          url: string;
          server: NodeHTTP.Server;
          seenAuth: Array<string | undefined>;
          terminated: boolean;
        }>((resolve, reject) => {
          const state = {
            url: "",
            seenAuth: [] as Array<string | undefined>,
            terminated: false,
          };
          const server = NodeHTTP.createServer((req, res) => {
            state.seenAuth.push(req.headers.authorization);
            if (req.method === "DELETE") {
              state.terminated = true;
              res.writeHead(204).end();
              return;
            }
            if (req.method === "GET") {
              res.writeHead(405).end();
              return;
            }
            if (mode === "auth") {
              res.writeHead(401, { "content-type": "text/plain" }).end("fixture-secret rejected");
              return;
            }
            if (mode === "malformed") {
              res.writeHead(200, { "content-type": "application/json" }).end("invalid json");
              return;
            }
            const chunks: Array<Buffer> = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                id?: unknown;
                method?: string;
                params?: { protocolVersion?: string; arguments?: { calls?: { path?: string } } };
              };
              if (!("id" in body)) {
                res.writeHead(202).end();
                return;
              }
              const result =
                body.method === "initialize"
                  ? {
                      protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
                      capabilities: { tools: {} },
                      serverInfo: { name: "fixture", version: "1" },
                    }
                  : {
                      content: [],
                      structuredContent: {
                        path: body.params?.arguments?.calls?.path,
                        ok: true,
                        value: {
                          results: [
                            { title: "Source", url: "https://example.com", content: "Snippet" },
                          ],
                        },
                      },
                    };
              res
                .writeHead(200, {
                  "content-type": "application/json",
                  "mcp-session-id": "sess-1",
                })
                .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
            });
          });
          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            state.url = `http://127.0.0.1:${addr.port}/mcp`;
            resolve({
              ...state,
              server,
              get terminated() {
                return state.terminated;
              },
            });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const clientLayer = (url: string) =>
  WebResearch.layerExecutor.pipe(
    Layer.provide(
      Layer.succeed(WebResearch.ExecutorCredentialSource, {
        read: Effect.succeed("fixture-secret"),
      }),
    ),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3CODE_EXECUTOR_MCP_URL: url,
      }),
    ),
  );

it.live(
  "connects directly to hosted Executor HTTP MCP with Bearer auth and terminates its session",
  () =>
    Effect.gen(function* () {
      const stub = yield* startStub("success");
      const result = yield* Effect.gen(function* () {
        const web = yield* WebResearch.WebResearch;
        return yield* web.search({ query: "question" });
      }).pipe(Effect.provide(WebResearch.layer.pipe(Layer.provide(clientLayer(stub.url)))));
      expect(result).toEqual([{ title: "Source", url: "https://example.com", snippet: "Snippet" }]);
      expect(stub.seenAuth.every((header) => header === "Bearer fixture-secret")).toBe(true);
      expect(stub.terminated).toBe(true);
    }).pipe(Effect.scoped),
);

it.live.each(["auth", "malformed"] as const)(
  "fails safely without leaking credentials on %s HTTP MCP responses",
  (mode) =>
    Effect.gen(function* () {
      const stub = yield* startStub(mode);
      const failure = yield* Effect.gen(function* () {
        const client = yield* WebResearch.ExecutorWebClient;
        return yield* client.connect;
      }).pipe(Effect.scoped, Effect.provide(clientLayer(stub.url)), Effect.flip);
      expect(failure.stage).toBe("connection");
      expect(failure.message).not.toContain("fixture-secret");
      expect(failure.message).toContain("hosted Executor MCP");
    }).pipe(Effect.scoped),
);
