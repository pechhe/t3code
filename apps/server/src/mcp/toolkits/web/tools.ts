import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as WebResearch from "../../WebResearch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const enabled = () => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  return scope?.toolProfile === "web-research" && scope.webResearchTools === true;
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, WebResearch.WebResearch],
};
const search = Tool.make("web_search", {
  ...shared,
  description:
    "Search the web for sources. Returns titles, URLs and snippets; use web_fetch to read a source.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1)),
    maxResults: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  success: Schema.Array(
    Schema.Struct({ title: Schema.String, url: Schema.String, snippet: Schema.String }),
  ),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabled);
const fetch = Tool.make("web_fetch", {
  ...shared,
  description: "Read a public web page as Markdown, optionally focused on a query.",
  parameters: Schema.Struct({
    url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
    query: Schema.optional(Schema.String),
  }),
  success: Schema.String,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabled);
export const WebToolkit = Toolkit.make(search, fetch);
