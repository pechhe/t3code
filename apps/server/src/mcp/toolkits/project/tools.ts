import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  BuildItemReferenceInput,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SecretRef,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BuildWorkItems from "../../../hq/BuildWorkItems.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HqAgentConnections from "../../../hq/HqAgentConnections.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Omit workspaceRoot to start a new project from just its title: the app makes a Git repository for it in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Each call creates a new request; an existing registered workspace is rejected. Clone separately with t3_project_clone when needed.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the repository directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with t3_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create a top-level thread with an explicit workspace before its agent starts. Use delegate_task for child subagents. workspaceStrategy: worktree (baseRef, branch), existing_worktree (worktreePath, branch), or root; omit it for the project default. Pass buildItem to bind a known Build item instead. Omit projectId/modelSelection/modes to inherit. scratch launches without a project. Put the task in message and retain threadId. Set watch=true to be woken when it finishes. Each call is a new launch with no retry key.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef, or, in a repository with slipjay.json, allocates a SlipJay workspace from the integration branch (branch, if given, names it; baseRef and startFromOrigin are ignored); existing_worktree binds worktreePath, which must be a git worktree or jj workspace of the project's repository; root uses the project checkout. Omitted means the project's default, not the caller's worktree: a fresh SlipJay workspace in a repository with slipjay.json, otherwise the project checkout. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
      }),
    ),
    buildItem: Schema.optional(
      BuildItemReferenceInput.annotate({
        description:
          "The Build item this thread works on, in a repository with slipjay.json: its number or a friendly ref such as YS-12 (also #<number> or a Build URL). T3 binds the thread to that item's SlipJay workspace before the agent starts, creating one attached to the item when it has none. Not with workspaceStrategy.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    watch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Watch the new thread from this one, as watch does, starting before its first message so a quick finish is not missed.",
      }),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    BuildWorkItems.BuildWorkItems,
    ManagedProjectFolders.ManagedProjectFolders,
    WorkspaceProvider.WorkspaceProvider,
    Path.Path,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const HqConnectionTool = Tool.make("t3_hq_connection", {
  ...shared,
  description:
    'Read, connect or disconnect T3\'s Weave connection, which every project in this environment shares. When connected, each Claude or Codex thread gets a `yardsmith-hq` MCP server that acts in Weave as that thread\'s own agent, on behalf of the person who made the delegation. The person normally connects with Settings → Integrations → Weave → Connect to Weave, which signs in to Weave in their browser. Only if that is unavailable, the person creates a delegation in Weave Settings → Connections → T3 agents; ask for it with request_secret, then pass {action:"connect", origin:"https://<weave origin>", delegation:<secretRef>}. T3 keeps it in its server secret store. Disconnecting stops new Weave calls; to revoke T3\'s access, the person revokes the delegation in Weave.',
  parameters: Schema.Struct({
    action: Schema.Literals(["read", "connect", "disconnect"]),
    origin: Schema.optional(TrimmedNonEmptyString),
    delegation: Schema.optional(SecretRef),
  }),
  success: Schema.Struct({ connected: Schema.Boolean, origin: Schema.NullOr(Schema.String) }),
  dependencies: [
    ...shared.dependencies,
    SecretRequests.SecretRequests,
    HqAgentConnections.HqAgentConnections,
  ],
}).annotate(Tool.Destructive, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
  HqConnectionTool,
);
