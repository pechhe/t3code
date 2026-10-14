// @effect-diagnostics nodeBuiltinImport:off - The OAuth loopback receiver is a CLI HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  auth as mcpAuth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { EnvironmentId, OrchestratorMcpCapabilitiesResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";

export class AgentCliError extends Schema.TaggedError<AgentCliError>()("AgentCliError", {
  reason: Schema.Literals([
    "endpoint",
    "credentials-missing",
    "credentials-expired",
    "storage",
    "authorization",
    "unsupported-server",
    "request",
    "environment-changed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `T3 agent client failed (${this.reason}).`;
  }
}
const Credential = Schema.Struct({
  endpoint: Schema.String,
  environmentId: EnvironmentId,
  accessToken: Schema.String,
  expiresAt: Schema.Number,
});
const jsonCredential = Schema.fromJsonString(Credential);
const encodeCredential = Schema.encodeEffect(jsonCredential);
const decodeCredential = Schema.decodeUnknownEffect(jsonCredential);
export class AgentCliClient extends Context.Service<
  AgentCliClient,
  {
    readonly login: (input: {
      readonly endpoint: string;
      readonly showAuthorization: (url: string) => Effect.Effect<void>;
    }) => Effect.Effect<
      { endpoint: string; environmentId: EnvironmentId; expiresAt: number },
      AgentCliError
    >;
    readonly identity: (
      endpoint: string,
    ) => Effect.Effect<
      { endpoint: string; environmentId: EnvironmentId; expiresAt: number },
      AgentCliError
    >;
    readonly call: (
      endpoint: string,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, AgentCliError>;
    readonly logout: (
      endpoint: string,
    ) => Effect.Effect<{ localCredentialRemoved: boolean; serverRevoked: boolean }, AgentCliError>;
  }
>()("t3/cli/AgentCliClient") {}

const decodeMcpResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
    content: Schema.optional(
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ),
  }),
);
const decodeJsonResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);
const decodeResult = Effect.fn(function* (raw: unknown) {
  const result = yield* decodeMcpResult(raw).pipe(
    Effect.mapError((cause) => new AgentCliError({ reason: "request", cause })),
  );
  if (result.isError === true) return yield* new AgentCliError({ reason: "request" });
  if (result.structuredContent !== undefined) {
    if (
      typeof result.structuredContent === "object" &&
      result.structuredContent !== null &&
      "_tag" in result.structuredContent &&
      result.structuredContent._tag === "OrchestratorMcpFailure"
    )
      return yield* new AgentCliError({ reason: "request" });
    return result.structuredContent;
  }
  const text =
    result.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("") ?? "";
  const parsed = yield* decodeJsonResult(text).pipe(
    Effect.mapError((cause) => new AgentCliError({ reason: "request", cause })),
  );
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "_tag" in parsed &&
    parsed._tag === "OrchestratorMcpFailure"
  )
    return yield* new AgentCliError({ reason: "request" });
  return parsed;
});

const make = Effect.gen(function* () {
  const secrets = yield* Secrets.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const endpointUrl = (input: string) =>
    Effect.try({
      try: () => {
        const url = new URL(input);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ))
        )
          throw new Error("endpoint");
        return url.href;
      },
      catch: () => new AgentCliError({ reason: "endpoint" }),
    });
  const key = (endpoint: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(endpoint)).pipe(
      Effect.map((bytes) => `agent-client-${Hex.encode(bytes)}`),
      Effect.orDie,
    );
  const read = Effect.fn(function* (input: string) {
    const endpoint = yield* endpointUrl(input);
    const encoded = yield* secrets
      .get(yield* key(endpoint))
      .pipe(Effect.mapError((cause) => new AgentCliError({ reason: "storage", cause })));
    if (Option.isNone(encoded)) return yield* new AgentCliError({ reason: "credentials-missing" });
    const credential = yield* decodeCredential(new TextDecoder().decode(encoded.value)).pipe(
      Effect.mapError((cause) => new AgentCliError({ reason: "storage", cause })),
    );
    if (credential.endpoint !== endpoint) return yield* new AgentCliError({ reason: "endpoint" });
    if (credential.expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new AgentCliError({ reason: "credentials-expired" });
    return credential;
  });
  const call = Effect.fn("AgentCliClient.call")(function* (
    input: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) {
    const credential = yield* read(input);
    const environmentId = yield* capabilities(credential.endpoint, credential.accessToken);
    if (environmentId !== credential.environmentId)
      return yield* new AgentCliError({ reason: "environment-changed" });
    const result = yield* callAcpMcpTool({
      endpoint: credential.endpoint,
      authorization: `Bearer ${credential.accessToken}`,
      tool,
      arguments: args,
    }).pipe(Effect.mapError((cause) => new AgentCliError({ reason: "request", cause })));
    return yield* decodeResult(result);
  });
  const capabilities = Effect.fn(function* (endpoint: string, token: string) {
    const result = yield* callAcpMcpTool({
      endpoint,
      authorization: `Bearer ${token}`,
      tool: "orchestrator_capabilities",
      arguments: {},
    }).pipe(Effect.mapError((cause) => new AgentCliError({ reason: "request", cause })));
    const decoded = yield* decodeCapabilities(yield* decodeResult(result)).pipe(
      Effect.mapError((cause) => new AgentCliError({ reason: "unsupported-server", cause })),
    );
    if (decoded.environmentId === undefined)
      return yield* new AgentCliError({ reason: "unsupported-server" });
    return decoded.environmentId;
  });
  return AgentCliClient.of({
    call,
    identity: Effect.fn("AgentCliClient.identity")(function* (endpoint) {
      const credential = yield* read(endpoint);
      const environmentId = yield* capabilities(credential.endpoint, credential.accessToken);
      if (environmentId !== credential.environmentId)
        return yield* new AgentCliError({ reason: "environment-changed" });
      return { endpoint: credential.endpoint, environmentId, expiresAt: credential.expiresAt };
    }),
    login: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* endpointUrl(input.endpoint);
          const existing = yield* Effect.result(read(endpoint));
          if (existing._tag === "Success") {
            const environmentId = yield* capabilities(endpoint, existing.success.accessToken);
            if (environmentId !== existing.success.environmentId)
              return yield* new AgentCliError({ reason: "environment-changed" });
            return { endpoint, environmentId, expiresAt: existing.success.expiresAt };
          }
          if (existing.failure.reason !== "credentials-missing") return yield* existing.failure;
          const state = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const callback = yield* Deferred.make<string>();
          const server = yield* NodeHttpServer.make(NodeHttp.createServer, {
            host: "127.0.0.1",
            port: 0,
            disablePreemptiveShutdown: true,
          }).pipe(
            Effect.mapError((cause) => new AgentCliError({ reason: "authorization", cause })),
          );
          if (server.address._tag === "UnixPathAddress")
            return yield* new AgentCliError({ reason: "authorization" });
          const redirectUrl = `http://127.0.0.1:${server.address.port}/callback`;
          yield* server.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const url = new URL(request.originalUrl, redirectUrl);
              const code = url.searchParams.get("code");
              if (
                request.method !== "GET" ||
                url.pathname !== "/callback" ||
                url.searchParams.get("state") !== state ||
                !code
              )
                return HttpServerResponse.text("Invalid authorization callback.", { status: 400 });
              yield* Deferred.succeed(callback, code);
              return HttpServerResponse.text("Authorization complete. Return to the terminal.");
            }),
          );
          let client: OAuthClientInformationMixed | undefined;
          let tokens: OAuthTokens | undefined;
          let verifier: string | undefined;
          let authorizationUrl: string | undefined;
          const provider: OAuthClientProvider = {
            redirectUrl,
            clientMetadata: {
              client_name: "T3 agent CLI",
              redirect_uris: [redirectUrl],
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            state: () => state,
            clientInformation: () => client,
            saveClientInformation: (value) => {
              client = value;
            },
            tokens: () => tokens,
            saveTokens: (value) => {
              tokens = value;
            },
            saveCodeVerifier: (value) => {
              verifier = value;
            },
            codeVerifier: () => {
              if (!verifier) throw new Error("Missing verifier");
              return verifier;
            },
            redirectToAuthorization: (url) => {
              authorizationUrl = url.href;
            },
          };
          const initial = yield* Effect.tryPromise({
            try: () =>
              mcpAuth(provider, {
                serverUrl: endpoint,
                scope: "orchestration:read orchestration:operate",
              }),
            catch: (cause) => new AgentCliError({ reason: "authorization", cause }),
          });
          if (initial !== "REDIRECT" || authorizationUrl === undefined)
            return yield* new AgentCliError({ reason: "authorization" });
          yield* input.showAuthorization(authorizationUrl);
          const code = yield* Deferred.await(callback).pipe(
            Effect.timeout("10 minutes"),
            Effect.mapError((cause) => new AgentCliError({ reason: "authorization", cause })),
          );
          const exchanged = yield* Effect.tryPromise({
            try: () => mcpAuth(provider, { serverUrl: endpoint, authorizationCode: code }),
            catch: (cause) => new AgentCliError({ reason: "authorization", cause }),
          });
          const issued = tokens;
          if (
            exchanged !== "AUTHORIZED" ||
            issued === undefined ||
            issued.token_type.toLowerCase() !== "bearer" ||
            issued.expires_in === undefined
          )
            return yield* new AgentCliError({ reason: "authorization" });
          const environmentId = yield* capabilities(endpoint, issued.access_token);
          const credential = {
            endpoint,
            environmentId,
            accessToken: issued.access_token,
            expiresAt: (yield* Clock.currentTimeMillis) + issued.expires_in * 1000,
          };
          const encoded = yield* encodeCredential(credential).pipe(
            Effect.mapError((cause) => new AgentCliError({ reason: "storage", cause })),
          );
          yield* secrets
            .set(yield* key(endpoint), new TextEncoder().encode(encoded))
            .pipe(Effect.mapError((cause) => new AgentCliError({ reason: "storage", cause })));
          return { endpoint, environmentId, expiresAt: credential.expiresAt };
        }),
      ),
    logout: Effect.fn("AgentCliClient.logout")(function* (input) {
      const endpoint = yield* endpointUrl(input);
      // OAuth credentials are environment-issued. Local logout does not pretend
      // to revoke the server grant; its owner can revoke it in Connections.
      yield* secrets
        .remove(yield* key(endpoint))
        .pipe(Effect.mapError((cause) => new AgentCliError({ reason: "storage", cause })));
      return { localCredentialRemoved: true, serverRevoked: false };
    }),
  });
});
export const layer = Layer.effect(AgentCliClient, make);
