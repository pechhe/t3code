import { NonNegativeInt, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as WorkspaceInspection from "../../../workspace/WorkspaceInspection.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SessionKey = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  description: "The key returned by agent_session_attach for the workspace to read.",
});
const Token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)).annotate({
  description:
    "The token from workspace_read_context. Refused as stale_source once the workspace changes.",
});
const Cursor = Schema.String.check(Schema.isMaxLength(512));

const Source = Schema.Struct({
  vcs: Schema.Literals(["git", "jj"]),
  revision: Schema.String,
  parents: Schema.Array(Schema.String),
  ref: Schema.NullOr(Schema.String),
  snapshotAt: Schema.NullOr(Schema.Number),
  token: Token,
  observedAt: Schema.String,
  observationComplete: Schema.Boolean,
});
const Change = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["M", "A", "D", "?"]),
  recordedIn: Schema.Literals(["vcs", "disk"]),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkspaceInspection.WorkspaceInspection,
    ProjectService.ProjectService,
    FileSystem.FileSystem,
    Path.Path,
  ],
};

const ReadContextTool = Tool.make("workspace_read_context", {
  ...shared,
  description:
    "Observe the exact attached workspace without changing it: VCS type, revision, parents, uncommitted changes (bounded) and a read-context token to pass to the other workspace_* tools. Git and jj state is read without snapshotting or locking. A jj working copy is read from its last snapshot and compared with the disk; snapshotAt says when that was. Nothing is copied or cached.",
  parameters: Schema.Struct({ externalSessionKey: SessionKey }),
  success: Schema.Struct({
    environmentId: Schema.String,
    projectId: Schema.String,
    workspace: Schema.String,
    source: Source,
    changes: Schema.Array(Change),
    changesOmitted: NonNegativeInt,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ReadFileTool = Tool.make("workspace_read_file", {
  ...shared,
  description:
    "Read a bounded range of one text file by workspace-relative path (no absolute paths, '..', ignored, binary, oversized, credential or secret files). Refused with stale_source if the workspace changed since the read context.",
  parameters: Schema.Struct({
    externalSessionKey: SessionKey,
    token: Token,
    path: Schema.String.check(Schema.isMaxLength(1024)),
    startLine: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    lineCount: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))),
  }),
  success: Schema.Struct({
    path: Schema.String,
    startLine: Schema.Number,
    endLine: Schema.Number,
    totalLines: Schema.Number,
    content: Schema.String,
    truncated: Schema.Boolean,
    source: Source,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const SearchTool = Tool.make("workspace_search", {
  ...shared,
  description:
    "Search tracked and non-ignored untracked files by literal text in content or in file names, in deterministic path order. Results page with nextCursor, which is bound to the read-context token and query.",
  parameters: Schema.Struct({
    externalSessionKey: SessionKey,
    token: Token,
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    mode: Schema.optional(Schema.Literals(["content", "name"])),
    caseSensitive: Schema.optional(Schema.Boolean),
    pathPrefix: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    cursor: Schema.optional(Cursor),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.optional(Schema.Number),
        text: Schema.optional(Schema.String),
      }),
    ),
    nextCursor: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
    filesScanned: Schema.Number,
    source: Source,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const StatusTool = Tool.make("workspace_vcs_status", {
  ...shared,
  description:
    "List the uncommitted changes of the attached Git or jj workspace (bounded), with the exact revision they are measured against.",
  parameters: Schema.Struct({ externalSessionKey: SessionKey, token: Token }),
  success: Schema.Struct({
    source: Source,
    changes: Schema.Array(Change),
    changesOmitted: NonNegativeInt,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const LogTool = Tool.make("workspace_vcs_log", {
  ...shared,
  description: "Recent history ending at the workspace's current revision.",
  parameters: Schema.Struct({
    externalSessionKey: SessionKey,
    token: Token,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        date: Schema.String,
        author: Schema.String,
        summary: Schema.String,
      }),
    ),
    source: Source,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const DiffTool = Tool.make("workspace_vcs_diff", {
  ...shared,
  description:
    "Diff text for the attached workspace. scope 'working' is uncommitted work (including untracked files and, in jj, edits made after the last snapshot); 'committed' is the latest committed change. Pages by nextCursor; files with denied paths or secret content are omitted and counted.",
  parameters: Schema.Struct({
    externalSessionKey: SessionKey,
    token: Token,
    scope: Schema.Literals(["working", "committed"]),
    path: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
    cursor: Schema.optional(Cursor),
  }),
  success: Schema.Struct({
    scope: Schema.Literals(["working", "committed"]),
    diff: Schema.String,
    nextCursor: Schema.NullOr(Schema.String),
    omittedPaths: NonNegativeInt,
    source: Source,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EvidenceTool = Tool.make("workspace_test_evidence", {
  ...shared,
  description:
    "Already-recorded SlipJay landing results for the attached workspace. Runs nothing. Each check reports its recorded outcome. sourceMatch is 'current' only when the landing published exactly this clean revision, 'stale' for a finished landing of other source, 'unverified' for an unfinished or unreadable record, and 'none' with evidence 'unavailable' when nothing was recorded; none of these is a pass for source it does not match.",
  parameters: Schema.Struct({ externalSessionKey: SessionKey, token: Token }),
  success: Schema.Struct({
    source: Source,
    evidence: Schema.Literals(["recorded", "unavailable"]),
    sourceMatch: Schema.Literals(["current", "stale", "unverified", "none"]),
    landing: Schema.optional(
      Schema.Struct({
        operationId: Schema.String,
        status: Schema.String,
        stage: Schema.String,
        terminal: Schema.optional(Schema.Boolean),
        submittedAt: Schema.optional(Schema.String),
        finishedAt: Schema.optional(Schema.String),
        failureReason: Schema.optional(Schema.String),
        checks: Schema.Array(
          Schema.Struct({
            command: Schema.String,
            purpose: Schema.String,
            outcome: Schema.String,
            durationMs: Schema.optional(Schema.Number),
            failingTests: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    note: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const WorkspaceToolkit = Toolkit.make(
  ReadContextTool,
  ReadFileTool,
  SearchTool,
  StatusTool,
  LogTool,
  DiffTool,
  EvidenceTool,
);
