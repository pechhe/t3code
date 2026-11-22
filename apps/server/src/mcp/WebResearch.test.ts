import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BitwardenSecrets from "../secrets/BitwardenSecrets.ts";
import * as WebResearch from "./WebResearch.ts";

const fixture = (responses: ReadonlyArray<unknown>) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = Layer.succeed(WebResearch.ExecutorWebClient, {
    connect: Effect.succeed({
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const response = responses[calls.length - 1];
        if (response instanceof Error) throw response;
        return response;
      },
    }),
  });
  return { calls, layer: WebResearch.layer.pipe(Layer.provide(client)) };
};
const search = { results: [{ title: "Source", url: "https://example.com", content: "Snippet" }] };
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
// Shapes recorded from hosted Executor's `call` and `resume` on 29 Oct 2026.
const approval = (tool: string) =>
  text({ status: "approval-required", requestId: "apr_1", invocation: { tool } });
const completed = (path: string, value: unknown) =>
  text({ status: "completed", execution: { ok: true, value: { path, ok: true, value } } });

it.effect("maps search results and sends only the fixed search path", () => {
  const f = fixture([text({ path: "tools.tavily.search.postSearch", ok: true, value: search })]);
  return Effect.gen(function* () {
    const web = yield* WebResearch.WebResearch;
    expect(yield* web.search({ query: "a question", maxResults: 3 })).toEqual([
      { title: "Source", url: "https://example.com", snippet: "Snippet" },
    ]);
    expect(f.calls).toEqual([
      {
        name: "call",
        args: {
          calls: {
            path: "tools.tavily.search.postSearch",
            input: {
              accountId: "acc_2c01e923-10d5-4bde-bef4-24e9e20626af",
              input: { body: { query: "a question", max_results: 3 } },
            },
          },
        },
      },
    ]);
  }).pipe(Effect.provide(f.layer));
});
it.effect("semantic search calls only Exa's fixed search path and accepts its approval", () => {
  const exa = {
    results: [
      { url: "https://example.com", title: "Source", highlights: ["First", "Second"] },
      { url: "https://example.org", title: null },
    ],
  };
  const f = fixture([approval("custom.search"), completed("tools.exa.custom.search", exa)]);
  return Effect.gen(function* () {
    const web = yield* WebResearch.WebResearch;
    expect(yield* web.search({ query: "question", maxResults: 2, engine: "exa" })).toEqual([
      { title: "Source", url: "https://example.com", snippet: "First\n\nSecond" },
      { title: "https://example.org", url: "https://example.org", snippet: "" },
    ]);
    expect(f.calls[0]?.args).toEqual({
      calls: {
        path: "tools.exa.custom.search",
        input: {
          accountId: "acc_1201639c-3dbc-4101-89ce-19f6609f6ffa",
          input: { query: "question", numResults: 2, contents: { highlights: true } },
        },
      },
    });
    expect(f.calls[1]?.name).toBe("resume");
  }).pipe(Effect.provide(f.layer));
});
it.effect.each(["search", "fetch"] as const)(
  "accepts an approval for the fixed %s read",
  (operation) => {
    const result =
      operation === "search"
        ? search
        : { results: [{ url: "https://example.com", raw_content: "# Page" }] };
    const path =
      operation === "search"
        ? "tools.tavily.search.postSearch"
        : "tools.tavily.extract.postExtract";
    const f = fixture([
      approval(operation === "search" ? "search.postSearch" : "extract.postExtract"),
      completed(path, result),
    ]);
    return Effect.gen(function* () {
      const web = yield* WebResearch.WebResearch;
      if (operation === "search") yield* web.search({ query: "question" });
      else expect(yield* web.fetch({ url: "https://example.com", query: "focus" })).toBe("# Page");
      expect(f.calls[1]).toEqual({
        name: "resume",
        args: { requestId: "apr_1", response: { action: "accept", content: {} } },
      });
      expect(f.calls[0]?.args).toMatchObject({ calls: { path } });
      if (operation === "fetch")
        expect(f.calls[0]?.args).toMatchObject({
          calls: {
            input: {
              input: {
                body: { urls: ["https://example.com"], query: "focus", format: "markdown" },
              },
            },
          },
        });
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect.each([
  { response: new Error("secret-bearing network failure"), stage: "search" },
  {
    response: { isError: true, content: [{ type: "text", text: "remote failure" }] },
    stage: "search",
  },
  { response: text({ status: "approval-required" }), stage: "approval" },
  { response: text({ results: "invalid" }), stage: "response" },
  {
    response: text({ path: "tools.other.write", ok: true, value: search }),
    stage: "response",
  },
  {
    response: approval("pages.write"),
    stage: "approval",
  },
])(
  "reports $stage failure without exposing remote content or credentials",
  ({ response, stage }) => {
    const f = fixture([response]);
    return Effect.gen(function* () {
      const web = yield* WebResearch.WebResearch;
      const error = yield* web.search({ query: "question" }).pipe(Effect.flip);
      expect(error.message).toBe(`Web research failed during ${stage}.`);
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("a burst of web research calls shares one credential read", () => {
  // Bitwarden's API answers a burst of `bws secret list` calls with 429, and every web tool call
  // reads EXECUTOR_PAT, so only the sixth read of a burst may fail here.
  let reads = 0;
  const store = Layer.succeed(BitwardenSecrets.BitwardenSecrets, {
    read: () =>
      Effect.suspend(() => {
        reads += 1;
        return reads > 5
          ? Effect.fail(
              new BitwardenSecrets.BitwardenSecretsError({
                reason: "failed",
                cause: new Error("429 Too Many Requests"),
              }),
            )
          : Effect.succeedSome("fixture-secret");
      }),
    select: (pick) => Effect.succeed(pick([])),
  });
  return Effect.gen(function* () {
    const credentials = yield* WebResearch.ExecutorCredentialSource;
    const tokens = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => index),
      () => credentials.read,
      { concurrency: "unbounded" },
    );
    expect(tokens).toEqual(Array.from({ length: 8 }, () => "fixture-secret"));
  }).pipe(Effect.provide(WebResearch.layerCredentials.pipe(Layer.provide(store))));
});
it.effect("does not keep accepting subsequent approval requests", () => {
  const f = fixture([approval("extract.postExtract"), approval("extract.postExtract")]);
  return Effect.gen(function* () {
    const web = yield* WebResearch.WebResearch;
    expect((yield* web.fetch({ url: "https://example.com" }).pipe(Effect.flip)).stage).toBe(
      "response",
    );
    expect(f.calls).toHaveLength(2);
  }).pipe(Effect.provide(f.layer));
});
