import * as ProcessRunner from "../processRunner.ts";
import * as NodeOS from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class WebResearchError extends Schema.TaggedError<WebResearchError>()("WebResearchError", {
  stage: Schema.Literals(["credentials", "connection", "search", "fetch", "approval", "response"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Web research failed during ${this.stage}.`;
  }
}

export class ExecutorCredentialSource extends Context.Service<
  ExecutorCredentialSource,
  {
    readonly read: Effect.Effect<string, WebResearchError>;
  }
>()("t3/mcp/WebResearch/ExecutorCredentialSource") {}

const decodeSecrets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))),
);
export const layerCredentials = Layer.effect(
  ExecutorCredentialSource,
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    return ExecutorCredentialSource.of({
      read: Effect.gen(function* () {
        const home = NodeOS.homedir();
        const result = yield* processes
          .run({
            command: "bws",
            args: ["secret", "list"],
            timeout: "30 seconds",
            env: {
              ...process.env,
              PATH: `${home}/.local/bin:${home}/.bun/bin:${home}/.local/share/bws/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
            },
            maxOutputBytes: 4 * 1024 * 1024,
          })
          .pipe(Effect.mapError((cause) => new WebResearchError({ stage: "credentials", cause })));
        if (result.code !== 0)
          return yield* new WebResearchError({
            stage: "credentials",
            cause: new Error("bws failed"),
          });
        const secrets = yield* decodeSecrets(result.stdout).pipe(
          Effect.mapError((cause) => new WebResearchError({ stage: "credentials", cause })),
        );
        const pat = secrets.find((secret) => secret.key === "EXECUTOR_PAT")?.value;
        if (!pat)
          return yield* new WebResearchError({
            stage: "credentials",
            cause: new Error("Missing EXECUTOR_PAT"),
          });
        return pat;
      }),
    });
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
    return ExecutorWebClient.of({
      connect: Effect.gen(function* () {
        const token = yield* credentials.read;
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new Client({ name: "t3-web-research", version: "1" })),
          (client) => Effect.promise(() => client.close()).pipe(Effect.ignore),
        );
        yield* Effect.tryPromise({
          try: () =>
            client.connect(
              new StreamableHTTPClientTransport(
                new URL(
                  process.env.T3CODE_EXECUTOR_MCP_URL ?? "https://mcp.executor.sh/org/peach/mcp",
                ),
                { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
              ),
            ),
          catch: (cause) => new WebResearchError({ stage: "connection", cause }),
        });
        return { callTool: (name, args) => client.callTool({ name, arguments: args }) };
      }),
    });
  }),
);

const SEARCH_PATH = "tools.tavily.search.postSearch";
const FETCH_PATH = "tools.tavily.extract.postExtract";
const DEFAULT_ACCOUNT_ID = "acc_2c01e923-10d5-4bde-bef4-24e9e20626af";
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
const decodeFetch = Schema.decodeUnknownSync(FetchResults);

export class WebResearch extends Context.Service<
  WebResearch,
  {
    readonly search: (input: {
      readonly query: string;
      readonly maxResults?: number | undefined;
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
    const accountId = process.env.T3CODE_TAVILY_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
    const call = Effect.fn("WebResearch.call")(function* (
      path: typeof SEARCH_PATH | typeof FETCH_PATH,
      body: Record<string, unknown>,
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
        { calls: { path, input: { accountId, input: { body } } } },
        path === SEARCH_PATH ? "search" : "fetch",
      );
      if (result.status === "approval-required") {
        // Executor names the paused tool without its `tools.<app>.` prefix.
        const invocation = result.invocation === undefined ? {} : record(result.invocation);
        if (
          (path !== SEARCH_PATH && path !== FETCH_PATH) ||
          typeof result.requestId !== "string" ||
          invocation.tool !== path.replace(/^tools\.tavily\./, "")
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
      search: Effect.fn("WebResearch.search")(function* ({ query, maxResults }) {
        const result = yield* call(SEARCH_PATH, { query, max_results: maxResults ?? 5 });
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
          urls: [url],
          ...(query === undefined ? {} : { query }),
          format: "markdown",
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
