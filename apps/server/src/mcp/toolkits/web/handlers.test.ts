import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as EffectContext from "effect/Context";
import { McpSchema } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Context from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WebResearch from "../../WebResearch.ts";
import * as Handlers from "./handlers.ts";
import { WebToolkit } from "./tools.ts";

const scope = (
  webResearchTools = true,
  endpointKey = "child-research",
): Context.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(),
  issuedAt: 0,
  thread: undefined,
  client: undefined,
  requestNamespace: "test",
  toolProfile: "web-research",
  webResearchTools,
  endpointKey,
});
const run = (
  invocation: Context.McpInvocationScope,
  response: unknown,
  tool: "web_search" | "web_fetch",
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(Context.McpInvocationContext, invocation),
      WebResearch.layer.pipe(
        Layer.provide(
          Layer.succeed(WebResearch.ExecutorWebClient, {
            connect: Effect.succeed({ callTool: async () => response }),
          }),
        ),
      ),
    );
    const toolkit = yield* WebToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    return yield* toolkit
      .handle(tool, tool === "web_search" ? { query: "question" } : { url: "https://example.com" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  });
it.effect("returns mapped sources through the MCP handler", () =>
  Effect.gen(function* () {
    const result = yield* run(
      scope(),
      { results: [{ title: "Title", url: "https://example.com", content: "Snippet" }] },
      "web_search",
    );
    expect(result.at(-1)?.result).toEqual([
      { title: "Title", url: "https://example.com", snippet: "Snippet" },
    ]);
  }),
);
it.effect("returns page text through the MCP handler", () =>
  Effect.gen(function* () {
    const result = yield* run(
      scope(),
      { results: [{ url: "https://example.com", raw_content: "# Page" }] },
      "web_fetch",
    );
    expect(result.at(-1)?.result).toBe("# Page");
  }),
);
it.effect("maps an Executor tool error to an MCP tool error", () =>
  Effect.gen(function* () {
    const result = yield* run(scope(), { isError: true }, "web_search");
    expect(result.at(-1)?.result).toMatchObject({
      code: "orchestration_error",
      message: "Web research failed during search.",
    });
  }),
);
it.effect.each([
  scope(false),
  scope(true, "child-reader"),
  { ...scope(), toolProfile: "source-reader" as const },
])("refuses callers outside the supplied web family", (invocation) =>
  Effect.gen(function* () {
    const result = yield* run(invocation, {}, "web_search");
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect.each([true, false])(
  "lists supplied web tools only when the credential enables them (%s)",
  (available) =>
    Effect.gen(function* () {
      for (const tool of Object.values(WebToolkit.tools)) {
        const enabled = EffectContext.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
        const listed = yield* Effect.sync(() =>
          enabled?.({
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          }),
        ).pipe(Effect.provideService(Context.McpInvocationContext, scope(available)));
        expect(listed).toBe(available);
      }
    }),
);
