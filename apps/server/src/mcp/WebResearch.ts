import * as BitwardenSecrets from "../secrets/BitwardenSecrets.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Scope from "effect/Scope";

const DEFAULT_EXECUTOR_MCP_URL = "https://mcp.executor.sh/mcp";

export class WebResearchError extends Schema.TaggedError<WebResearchError>()("WebResearchError", {
  stage: Schema.Literals(["credentials", "connection", "search", "fetch", "approval", "response"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    if (this.stage === "connection")
      return "Could not connect to hosted Executor MCP. Check network access and the saved EXECUTOR_PAT credential.";
    return `Web research failed during ${this.stage}.`;
  }
}

const CREDENTIAL_TTL = Duration.seconds(30);

export class ExecutorCredentialSource extends Context.Service<
  ExecutorCredentialSource,
  {
    readonly read: Effect.Effect<string, WebResearchError>;
  }
>()("t3/mcp/WebResearch/ExecutorCredentialSource") {}

export const layerCredentials = Layer.effect(
  ExecutorCredentialSource,
  Effect.gen(function* () {
    const secrets = yield* BitwardenSecrets.BitwardenSecrets;
    // Bitwarden's API answers a burst of `bws secret list` calls with 429, and every web tool call
    // reads EXECUTOR_PAT, so one read stands for the burst and a failure is retried by the next.
    const read = yield* secrets.read("EXECUTOR_PAT").pipe(
      Effect.mapError((cause) => new WebResearchError({ stage: "credentials", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            new WebResearchError({
              stage: "credentials",
              cause: new Error("Missing EXECUTOR_PAT"),
            }),
          onSome: Effect.succeed,
        }),
      ),
      Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? CREDENTIAL_TTL : Duration.zero)),
    );
    return ExecutorCredentialSource.of({ read });
  }),
);

export class ExecutorWebClient extends Context.Service<
  ExecutorWebClient,
  {
    readonly connect: Effect.Effect<
      {
        readonly callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      },
      WebResearchError,
      Scope.Scope
    >;
  }
>()("t3/mcp/WebResearch/ExecutorWebClient") {}

export const layerExecutor = Layer.effect(
  ExecutorWebClient,
  Effect.gen(function* () {
    const credentials = yield* ExecutorCredentialSource;
    const hostEnvironment = yield* HostProcess.Environment;
    const endpoint = hostEnvironment.T3CODE_EXECUTOR_MCP_URL ?? DEFAULT_EXECUTOR_MCP_URL;
    return ExecutorWebClient.of({
      connect: Effect.gen(function* () {
        const token = yield* credentials.read;
        const url = yield* Effect.try({
          try: () => new URL(endpoint),
          catch: (cause) => new WebResearchError({ stage: "connection", cause }),
        });
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new Client({ name: "t3-web-research", version: "1" })),
          (client) =>
            Effect.promise(async () => {
              await transport.terminateSession().catch(() => undefined);
              await client.close().catch(() => undefined);
            }).pipe(Effect.ignore),
        );
        yield* Effect.tryPromise({
          try: () => client.connect(transport as Transport),
          catch: (cause) => new WebResearchError({ stage: "connection", cause }),
        });
        return { callTool: (name, args) => client.callTool({ name, arguments: args }) };
      }),
    });
  }),
);

// The only Executor tools T3 calls: agents reach these reads, never Executor itself.
const SEARCH_PATH = "tools.tavily.search.postSearch";
const FETCH_PATH = "tools.tavily.extract.postExtract";
const EXA_SEARCH_PATH = "tools.exa.custom.search";
type ReadPath = typeof SEARCH_PATH | typeof FETCH_PATH | typeof EXA_SEARCH_PATH;
const DEFAULT_ACCOUNT_ID = "acc_2c01e923-10d5-4bde-bef4-24e9e20626af";
const DEFAULT_EXA_ACCOUNT_ID = "acc_1201639c-3dbc-4101-89ce-19f6609f6ffa";
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

function unpack(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  if (envelope.isError === true) throw new Error("Executor returned a tool error");
  if (envelope.structuredContent !== undefined) return record(envelope.structuredContent);
  if (Array.isArray(envelope.content)) {
    const text = envelope.content
      .map((item) => record(item))
      .find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error("Executor returned no text");
    return decodeJsonRecord(text);
  }
  return envelope;
}

const SearchResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      content: Schema.String,
    }),
  ),
});
const ExaSearchResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.optional(Schema.NullOr(Schema.String)),
      highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const FetchResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      raw_content: Schema.String,
    }),
  ),
});

/**
 * The tool's own value from an Executor answer: a resumed approval wraps it in
 * `{status: "completed", execution: {ok, value}}`, and `call` answers `{path, ok, value}`.
 */
function toolValue(answer: Record<string, unknown>, path: string): Record<string, unknown> {
  let current = answer;
  if (current.status === "completed" && current.execution !== undefined) {
    const execution = record(current.execution);
    if (execution.ok !== true) throw new Error("Executor execution failed");
    current = record(execution.value);
  }
  if (current.path !== undefined && current.path !== path)
    throw new Error("Executor answered another tool");
  if (current.ok === false) throw new Error("Executor tool call failed");
  return current.value === undefined ? current : record(current.value);
}

const decodeSearch = Schema.decodeUnknownSync(SearchResults);
const decodeExaSearch = Schema.decodeUnknownSync(ExaSearchResults);
const decodeFetch = Schema.decodeUnknownSync(FetchResults);

export class WebResearch extends Context.Service<
  WebResearch,
  {
    readonly search: (input: {
      readonly query: string;
      readonly maxResults?: number | undefined;
      readonly engine?: "tavily" | "exa" | undefined;
    }) => Effect.Effect<
      ReadonlyArray<{ title: string; url: string; snippet: string }>,
      WebResearchError
    >;
    readonly fetch: (input: {
      readonly url: string;
      readonly query?: string | undefined;
    }) => Effect.Effect<string, WebResearchError>;
  }
>()("t3/mcp/WebResearch") {}

export const layer = Layer.effect(
  WebResearch,
  Effect.gen(function* () {
    const executor = yield* ExecutorWebClient;
    const hostEnvironment = yield* HostProcess.Environment;
    const accountId = hostEnvironment.T3CODE_TAVILY_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
    const exaAccountId = hostEnvironment.T3CODE_EXA_ACCOUNT_ID ?? DEFAULT_EXA_ACCOUNT_ID;
    const call = Effect.fn("WebResearch.call")(function* (
      path: ReadPath,
      input: Record<string, unknown>,
    ) {
      const client = yield* executor.connect;
      const request = (
        name: string,
        args: Record<string, unknown>,
        stage: WebResearchError["stage"],
      ) =>
        Effect.tryPromise({
          try: async () => unpack(await client.callTool(name, args)),
          catch: (cause) => new WebResearchError({ stage, cause }),
        });
      let result = yield* request(
        "call",
        { calls: { path, input } },
        path === FETCH_PATH ? "fetch" : "search",
      );
      if (result.status === "approval-required") {
        // Executor names the paused tool without its `tools.<app>.` prefix.
        const invocation = result.invocation === undefined ? {} : record(result.invocation);
        if (
          typeof result.requestId !== "string" ||
          invocation.tool !== path.replace(/^tools\.[^.]+\./, "")
        ) {
          return yield* new WebResearchError({
            stage: "approval",
            cause: new Error("Unrecognized approval"),
          });
        }
        result = yield* request(
          "resume",
          { requestId: result.requestId, response: { action: "accept", content: {} } },
          "approval",
        );
      }
      return yield* Effect.try({
        try: () => toolValue(result, path),
        catch: (cause) => new WebResearchError({ stage: "response", cause }),
      });
    }, Effect.scoped);
    return WebResearch.of({
      search: Effect.fn("WebResearch.search")(function* ({ query, maxResults, engine }) {
        if (engine === "exa") {
          const exa = yield* call(EXA_SEARCH_PATH, {
            accountId: exaAccountId,
            input: { query, numResults: maxResults ?? 5, contents: { highlights: true } },
          });
          return yield* Effect.try({
            try: () =>
              decodeExaSearch(exa).results.map(({ title, url, highlights }) => ({
                title: title ?? url,
                url,
                snippet: (highlights ?? []).join("\n\n"),
              })),
            catch: (cause) => new WebResearchError({ stage: "response", cause }),
          });
        }
        const result = yield* call(SEARCH_PATH, {
          accountId,
          input: { body: { query, max_results: maxResults ?? 5 } },
        });
        return yield* Effect.try({
          try: () =>
            decodeSearch(result).results.map(({ title, url, content }) => ({
              title,
              url,
              snippet: content,
            })),
          catch: (cause) => new WebResearchError({ stage: "response", cause }),
        });
      }),
      fetch: Effect.fn("WebResearch.fetch")(function* ({ url, query }) {
        const result = yield* call(FETCH_PATH, {
          accountId,
          input: {
            body: { urls: [url], ...(query === undefined ? {} : { query }), format: "markdown" },
          },
        });
        return yield* Effect.try({
          try: () => {
            const pages = decodeFetch(result).results;
            if (pages.length === 0) throw new Error("No extracted page");
            return pages.map((page) => page.raw_content).join("\n\n");
          },
          catch: (cause) => new WebResearchError({ stage: "response", cause }),
        });
      }),
    });
  }),
);
