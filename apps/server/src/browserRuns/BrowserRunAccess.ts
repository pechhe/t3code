import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import {
  assertBoundedBrowserCaller,
  projectAllowsBoundedBrowser,
} from "../mcp/ManagedBrowserAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BrowserRuns from "./BrowserRuns.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** A project's settings, read on every call so a run cannot outlive turning browsing off. */
const assertProjectAllowsRuns = Effect.fn("BrowserRunAccess.assertProject")(function* (
  projectId: ProjectId,
) {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const resolved = Option.isSome(settings)
    ? yield* settings.value.getSettings.pipe(
        Effect.map((value) => resolveProjectSettings(value, projectId).settings),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  if (resolved === undefined)
    return yield* refuse("Browser access could not be confirmed; browser runs are paused.");
  if (!projectAllowsBoundedBrowser(resolved))
    return yield* refuse("Integrated agent browsing is turned off for this project.");
});

/** An outside client acts here only with write access, as for any tool that acts. */
const assertClientCaller = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.client === undefined || McpInvocationContext.isReadOnlyClient(scope.client)
    ? Effect.fail(
        refuse("Browser runs need a T3 thread's credential or a client with write access."),
      )
    : Effect.void;

export interface RunAccessServices {
  readonly runs: BrowserRuns.BrowserRuns["Service"];
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  readonly path: Path.Path;
}

/** The project whose root holds `workspace`, nearest first, as `t3` finds its project. */
const projectForWorkspace = Effect.fn("BrowserRunAccess.projectForWorkspace")(function* (
  services: RunAccessServices,
  workspace: string | undefined,
) {
  const { path, projects } = services;
  if (workspace === undefined || !path.isAbsolute(workspace))
    return yield* refuse(
      "Outside a T3 thread, name the project's directory: pass an absolute `workspace`.",
    );
  let directory = path.resolve(workspace);
  for (;;) {
    const found = yield* projects
      .findActiveByWorkspaceRoot(directory)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(found)) return found.value.projectId;
    const parent = path.dirname(directory);
    if (parent === directory)
      return yield* refuse(`No T3 project holds ${workspace}. Add the project in T3 first.`);
    directory = parent;
  }
});

/** What opening a run needs: the browser scope it acts with and the project whose settings apply. */
export const openingRun = Effect.fn("BrowserRunAccess.openingRun")(function* (
  services: RunAccessServices,
  workspace: string | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread !== undefined) {
    const { caller, scope: bounded } = yield* assertBoundedBrowserCaller({ checkSettings: true });
    return {
      caller: scope,
      projectId: caller.caller!.projectId,
      browserScope: (_runId: string) => bounded,
    };
  }
  yield* assertClientCaller(scope);
  const projectId = yield* projectForWorkspace(services, workspace);
  yield* assertProjectAllowsRuns(projectId);
  return {
    caller: scope,
    projectId,
    browserScope: (runId: string) => BrowserRuns.clientRunScope(scope, projectId, runId),
  };
});

/**
 * The caller's open run, rechecked on every call: a thread's live run, task and project, or an
 * outside client's write access and its run's project. Closing skips the settings check, so a
 * run can still end after browsing is turned off.
 */
export const usingRun = Effect.fn("BrowserRunAccess.usingRun")(function* (
  runs: BrowserRuns.BrowserRuns["Service"],
  options: { readonly checkSettings: boolean },
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread !== undefined) yield* assertBoundedBrowserCaller(options);
  else yield* assertClientCaller(scope);
  const run = yield* runs.use(scope, scope.browserRunId);
  if (scope.thread === undefined && options.checkSettings)
    yield* assertProjectAllowsRuns(run.projectId);
  return run;
});
