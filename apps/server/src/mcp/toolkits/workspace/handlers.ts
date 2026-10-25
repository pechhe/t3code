import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ExternalWork from "../../../agents/ExternalAgentWorkService.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Inspection from "../../../workspace/WorkspaceInspection.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkspaceToolkit } from "./tools.ts";

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** A refusal keeps its typed reason as a prefix, since the MCP failure has a fixed code set. */
const inspectionFailure = (error: Inspection.WorkspaceInspectionError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid_request" || error.reason === "invalid_cursor"
        ? "invalid_request"
        : "orchestration_error",
    message: `[${error.reason}] ${error.message}`,
  });

/**
 * The attached workspace of one external session. The session lookup already requires the
 * calling OAuth client to own it; the workspace is then re-checked on every call so a removed
 * or replaced checkout is refused rather than answered from the project root.
 */
const bound = Effect.fn("workspace.bound")(function* (externalSessionKey: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const external = yield* Effect.serviceOption(ExternalWork.ExternalAgentWorkService);
  if (Option.isNone(external)) return yield* denied("External agent work is not configured here.");
  const session = yield* external.value
    .session(scope, externalSessionKey)
    .pipe(Effect.mapError(() => denied("This workspace session is not available to this client.")));
  const projects = yield* Projects.ProjectService;
  const project = yield* projects
    .getById(session.projectId)
    .pipe(Effect.mapError(() => denied("This workspace session is not available to this client.")));
  if (Option.isNone(project)) return yield* denied("The attached project is no longer registered.");
  const fs = yield* FileSystem.FileSystem;
  const intact = yield* fs.realPath(session.workspacePath).pipe(
    Effect.map((real) => real === session.workspacePath),
    Effect.orElseSucceed(() => false),
  );
  if (!intact)
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "[workspace_unavailable] The attached workspace has moved or been removed.",
    });
  return { session, root: session.workspacePath };
});

const audit = (tool: string, session: { readonly key: string }, fields: Record<string, unknown>) =>
  Effect.logInfo("workspace.inspection", { tool, session: session.key.slice(0, 12), ...fields });

/** Denied paths are counted, not listed, so a workspace whose only change is `.env` is not reported clean. */
const boundedChanges = (changes: ReadonlyArray<Inspection.ChangedPath>) => {
  const listable = changes.filter((change) => !Inspection.isDeniedPath(change.path));
  const shown: Array<Inspection.ChangedPath> = [];
  let bytes = 0;
  for (const change of listable) {
    bytes += change.path.length + 40;
    if (
      shown.length >= Inspection.INSPECTION_LIMITS.maxStatusEntries ||
      bytes > Inspection.INSPECTION_LIMITS.statusBytes
    )
      break;
    shown.push(change);
  }
  return { changes: shown, changesOmitted: changes.length - shown.length };
};
const publicSource = (source: Inspection.SourceObservation) => ({
  vcs: source.vcs,
  revision: source.revision,
  parents: source.parents,
  ref: source.ref,
  snapshotAt: source.snapshotAt,
  token: source.token,
  observedAt: source.observedAt,
  observationComplete: source.observationComplete,
});

export const layer = McpToolAccess.toLayer(WorkspaceToolkit, {
  workspace_read_context: McpToolAccess.reads(({ externalSessionKey }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const source = yield* inspection.observe(root).pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_read_context", session, { revision: source.revision });
      return {
        environmentId: session.environmentId,
        projectId: session.projectId,
        workspace: root,
        source: publicSource(source),
        ...boundedChanges(source.changes),
      };
    }),
  ),
  workspace_read_file: McpToolAccess.reads(({ externalSessionKey, ...input }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const read = yield* inspection.readFile(root, input).pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_read_file", session, {
        revision: read.source.revision,
        path: read.path,
      });
      return { ...read, source: publicSource(read.source) };
    }),
  ),
  workspace_search: McpToolAccess.reads(({ externalSessionKey, mode, ...input }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const page = yield* inspection
        .search(root, { ...input, mode: mode ?? "content" })
        .pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_search", session, {
        revision: page.source.revision,
        queryLength: input.query.length,
      });
      return { ...page, source: publicSource(page.source) };
    }),
  ),
  workspace_vcs_status: McpToolAccess.reads(({ externalSessionKey, token }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const source = yield* inspection
        .requireCurrent(root, token)
        .pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_vcs_status", session, { revision: source.revision });
      return { source: publicSource(source), ...boundedChanges(source.changes) };
    }),
  ),
  workspace_vcs_log: McpToolAccess.reads(({ externalSessionKey, ...input }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const read = yield* inspection.log(root, input).pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_vcs_log", session, { revision: read.source.revision });
      return { ...read, source: publicSource(read.source) };
    }),
  ),
  workspace_vcs_diff: McpToolAccess.reads(({ externalSessionKey, ...input }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const page = yield* inspection.diff(root, input).pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_vcs_diff", session, {
        revision: page.source.revision,
        scope: page.scope,
      });
      return { ...page, source: publicSource(page.source) };
    }),
  ),
  workspace_test_evidence: McpToolAccess.reads(({ externalSessionKey, token }) =>
    Effect.gen(function* () {
      const { session, root } = yield* bound(externalSessionKey);
      const inspection = yield* Inspection.WorkspaceInspection;
      const read = yield* inspection.evidence(root, token).pipe(Effect.mapError(inspectionFailure));
      yield* audit("workspace_test_evidence", session, { revision: read.source.revision });
      return { ...read, source: publicSource(read.source) };
    }),
  ),
});
