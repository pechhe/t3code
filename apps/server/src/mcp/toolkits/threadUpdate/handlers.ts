import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorHandlers from "../orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import * as ThreadHandlers from "../thread/handlers.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import {
  THREAD_UPDATE_ROUTES,
  type ThreadUpdateAction,
  type ThreadUpdateRoute,
  type ThreadUpdateTool,
  ThreadUpdateToolkit,
} from "./tools.ts";

type Routed = McpToolAccess.Dispatch<
  Tool.Success<typeof ThreadUpdateTool>,
  Tool.Failure<typeof ThreadUpdateTool>,
  Tool.Requirements<typeof ThreadUpdateTool>
>;

const routeOf = new Map<ThreadUpdateAction, ThreadUpdateRoute>(
  Object.entries(THREAD_UPDATE_ROUTES).flatMap(([route, { actions }]) =>
    actions.map((action) => [action, route as ThreadUpdateRoute] as const),
  ),
);

const declarations = {
  t3_thread_update: OrchestratorHandlers.handlers.t3_thread_update,
  t3_thread_organize: ThreadHandlers.handlers.t3_thread_organize,
  t3_thread_configure: ThreadHandlers.handlers.t3_thread_configure,
  t3_thread_move_to_project: ThreadHandlers.handlers.t3_thread_move_to_project,
  t3_thread_suggest_project: ThreadHandlers.handlers.t3_thread_suggest_project,
  t3_thread_transfer: ThreadHandlers.handlers.t3_thread_transfer,
} satisfies Record<ThreadUpdateRoute, unknown>;

const tools: Record<ThreadUpdateRoute, Tool.Any> = {
  t3_thread_update: OrchestratorToolkit.tools.t3_thread_update,
  t3_thread_organize: ThreadToolkit.tools.t3_thread_organize,
  t3_thread_configure: ThreadToolkit.tools.t3_thread_configure,
  t3_thread_move_to_project: ThreadToolkit.tools.t3_thread_move_to_project,
  t3_thread_suggest_project: ThreadToolkit.tools.t3_thread_suggest_project,
  t3_thread_transfer: ThreadToolkit.tools.t3_thread_transfer,
};

const decoders = Object.fromEntries(
  Object.entries(tools).map(([route, tool]) => [
    route,
    Schema.decodeUnknownEffect(tool.parametersSchema as Schema.Codec<unknown, unknown>),
  ]),
) as Record<ThreadUpdateRoute, (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The input the action's own tool takes: its fields, and the action name it knows. */
const routedInput = (
  route: ThreadUpdateRoute,
  { action, ...fields }: { readonly action: ThreadUpdateAction; readonly [key: string]: unknown },
) => ({
  ...fields,
  ...(route === "t3_thread_update" || route === "t3_thread_organize" ? { action } : {}),
  ...(route === "t3_thread_transfer" ? { action: action === "transfers" ? "status" : action } : {}),
});

export const pickThreadUpdate = (params: {
  readonly action: ThreadUpdateAction;
  readonly [key: string]: unknown;
}): Effect.Effect<Routed, OrchestratorMcpFailure> => {
  const route = routeOf.get(params.action);
  if (route === undefined) return Effect.fail(invalid(`Unknown action ${params.action}.`));
  const allowed: ReadonlyArray<string> = THREAD_UPDATE_ROUTES[route].fields;
  const extra = Object.entries(params)
    .filter(([key, value]) => key !== "action" && value !== undefined && !allowed.includes(key))
    .map(([key]) => key);
  if (extra.length > 0)
    return Effect.fail(
      invalid(
        `${params.action} does not take ${extra.join(", ")}${allowed.length === 0 ? "" : `; it takes ${allowed.join(", ")}`}.`,
      ),
    );
  return decoders[route](routedInput(route, params)).pipe(
    Effect.mapError((cause) => invalid(cause.message)),
    Effect.map((input) => ({ declaration: declarations[route], params: input }) as Routed),
  );
};

export const layer = McpToolAccess.toLayer(ThreadUpdateToolkit, {
  t3_thread_update: McpToolAccess.dispatches(pickThreadUpdate),
});
