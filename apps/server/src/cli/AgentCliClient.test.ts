import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vite-plus/test";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as AgentCliClient from "./AgentCliClient.ts";

const endpoint = "https://agent.test/mcp";
const environmentId = EnvironmentId.make("environment:agent-cli-test");
const originalFetch = globalThis.fetch.bind(globalThis);
const accessToken = "fake-bearer-access-token-never-print";
const metadata = {
  issuer: "https://agent.test",
  authorization_endpoint: "https://agent.test/authorize",
  token_endpoint: "https://agent.test/token",
  registration_endpoint: "https://agent.test/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
};
const capabilities = {
  environmentId,
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 10,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.T3_ACP_API_KEY;
  delete process.env.T3_ACP_BASE_URL;
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mcpResponse(id: unknown, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
  });
}

function stubRemote(input: {
  readonly environmentId?: typeof environmentId;
  readonly toolResult?: unknown;
  readonly unsupported?: boolean;
  readonly tokenFailure?: boolean;
}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (async (inputUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof inputUrl === "string" || inputUrl instanceof URL ? inputUrl : inputUrl.url,
    );
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      return originalFetch(inputUrl, init);
    requests.push({ url: url.href, ...(init === undefined ? {} : { init }) });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: endpoint,
        authorization_servers: ["https://agent.test"],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") return json(metadata);
    if (url.pathname === "/register") {
      return json(
        {
          ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
          client_id: "publicclientid",
        },
        201,
      );
    }
    if (url.pathname === "/token") {
      if (input.tokenFailure) return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
        scope: "orchestration:read orchestration:operate",
      });
    }
    if (url.pathname === "/mcp" && init?.method === "POST") {
      const message = JSON.parse(String(init.body)) as {
        id?: unknown;
        method?: string;
        params?: { name?: string };
      };
      if (message.method === "initialize") {
        return mcpResponse(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      }
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "tools/call") {
        if (message.params?.name === "orchestrator_capabilities") {
          return mcpResponse(message.id, {
            structuredContent: input.unsupported
              ? { environmentId: input.environmentId ?? environmentId }
              : {
                  ...capabilities,
                  environmentId: input.environmentId ?? environmentId,
                },
            content: [],
          });
        }
        return mcpResponse(
          message.id,
          input.toolResult ?? {
            structuredContent: {
              taskId: "node:fixture-task",
              status: "queued",
              text: "safe structured output",
            },
            content: [],
          },
        );
      }
    }
    return json({ error: "unexpected fixture request" }, 404);
  }) as typeof fetch);
  return requests;
}

const withClient = <A, E, R>(
  use: (input: {
    readonly client: AgentCliClient.AgentCliClient["Service"];
    readonly directory: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, AgentCliClient.AgentCliClient | FileSystem.FileSystem | R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "agent-cli-client-test-" }),
      );
      const layer = AgentCliClient.layer.pipe(
        Layer.provideMerge(Secrets.layerAtDirectory(`${directory}/secrets`)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* AgentCliClient.AgentCliClient;
        return yield* use({ client, directory, fs });
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const authorize =
  (native: typeof fetch = originalFetch) =>
  (url: string) =>
    Effect.promise(async () => {
      const authorization = new URL(url);
      const callback = authorization.searchParams.get("redirect_uri");
      const state = authorization.searchParams.get("state");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("scope")).toContain("orchestration:operate");
      expect(callback).not.toBeNull();
      expect(state).not.toBeNull();
      const wrong = await native(`${callback!}?code=wrongcode&state=wrongstate`);
      expect(wrong.status).toBe(400);
      const valid = await native(
        `${callback!}?code=fixturecode&state=${encodeURIComponent(state!)}`,
      );
      expect(valid.status).toBe(200);
    });

it.effect(
  "performs OAuth PKCE login, stores only a protected credential, and returns safe metadata",
  () => {
    const requests = stubRemote({});
    return withClient(({ client, directory, fs }) =>
      Effect.gen(function* () {
        let shownAuthorization: string | undefined;
        const result = yield* client.login({
          endpoint,
          showAuthorization: (url) => {
            shownAuthorization = url;
            return authorize()(url);
          },
        });
        expect(result.endpoint).toBe(endpoint);
        expect(result.environmentId).toBe(environmentId);
        expect(JSON.stringify(result)).not.toContain(accessToken);
        expect(shownAuthorization).toBeDefined();
        expect(new URL(shownAuthorization!).searchParams.get("client_id")).toBe("publicclientid");
        const secretDir = `${directory}/secrets`;
        const secretFiles = yield* fs.readDirectory(secretDir);
        expect(secretFiles).toHaveLength(1);
        const secretInfo = yield* fs.stat(`${secretDir}/${secretFiles[0]}`);
        const directoryInfo = yield* fs.stat(secretDir);
        expect(secretInfo.mode & 0o777).toBe(0o600);
        expect(directoryInfo.mode & 0o777).toBe(0o700);
        const stored = yield* fs.readFileString(`${secretDir}/${secretFiles[0]}`);
        expect(stored).toContain(accessToken);
        expect(requests.some((request) => request.url.endsWith("/register"))).toBe(true);
        expect(requests.some((request) => request.url.endsWith("/token"))).toBe(true);
        const identity = yield* client.identity(endpoint);
        expect(JSON.stringify(identity)).not.toContain(accessToken);
      }),
    );
  },
);

it.effect("unwraps structured MCP tool results without exposing the bearer token", () => {
  stubRemote({});
  return withClient(({ client }) =>
    Effect.gen(function* () {
      yield* client.login({ endpoint, showAuthorization: authorize() });
      const output = yield* client.call(endpoint, "orchestrator_task_status", {
        taskId: "node:fixture-task",
      });
      expect(output).toEqual({
        taskId: "node:fixture-task",
        status: "queued",
        text: "safe structured output",
      });
      expect(JSON.stringify(output)).not.toContain(accessToken);
    }),
  );
});

it.effect("rejects missing, expired, and changed-environment credentials", () => {
  stubRemote({});
  return withClient(({ client, directory, fs }) =>
    Effect.gen(function* () {
      process.env.T3_ACP_API_KEY = accessToken;
      process.env.T3_ACP_BASE_URL = endpoint;
      const missing = yield* client.identity(endpoint).pipe(Effect.flip);
      expect(missing.reason).toBe("credentials-missing");
      yield* client.login({ endpoint, showAuthorization: authorize() });
      const secretDir = `${directory}/secrets`;
      const secretFiles = yield* fs.readDirectory(secretDir);
      const secretPath = `${secretDir}/${secretFiles[0]}`;
      const saved = JSON.parse(yield* fs.readFileString(secretPath)) as Record<string, unknown>;
      yield* fs.writeFileString(secretPath, JSON.stringify({ ...saved, expiresAt: 0 }));
      const expired = yield* client.identity(endpoint).pipe(Effect.flip);
      expect(expired.reason).toBe("credentials-expired");
      yield* fs.writeFileString(
        secretPath,
        JSON.stringify({ ...saved, expiresAt: Number.MAX_SAFE_INTEGER }),
      );
      stubRemote({ environmentId: EnvironmentId.make("environment:replaced") });
      const changed = yield* client.identity(endpoint).pipe(Effect.flip);
      expect(changed.reason).toBe("environment-changed");
    }),
  );
});

it.effect("refuses unsupported servers and keeps raw authorization out of failures", () => {
  stubRemote({ unsupported: true });
  return withClient(({ client }) =>
    Effect.gen(function* () {
      const failure = yield* client
        .login({ endpoint, showAuthorization: authorize() })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("unsupported-server");
      expect(failure.message).not.toContain(accessToken);
    }),
  );
});

it.effect("does not persist credentials when OAuth authorization fails", () => {
  stubRemote({ tokenFailure: true });
  return withClient(({ client, fs, directory }) =>
    Effect.gen(function* () {
      const failure = yield* client
        .login({ endpoint, showAuthorization: authorize() })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("authorization");
      const secretDir = `${directory}/secrets`;
      const files = yield* fs.readDirectory(secretDir);
      expect(files).toEqual([]);
      const missing = yield* client.identity(endpoint).pipe(Effect.flip);
      expect(missing.reason).toBe("credentials-missing");
    }),
  );
});

it.effect("treats returned MCP failures as safe CLI errors", () => {
  stubRemote({
    toolResult: {
      structuredContent: {
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
        message: accessToken,
      },
      content: [],
    },
  });
  return withClient(({ client }) =>
    Effect.gen(function* () {
      yield* client.login({ endpoint, showAuthorization: authorize() });
      const result = yield* client.call(endpoint, "delegate_task", {}).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("request");
        expect(result.failure.message).not.toContain(accessToken);
      }
    }),
  );
});
