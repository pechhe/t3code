import { McpAttachmentInput } from "../attachment/input.ts";
import {
  WEAVE_NAMES,
  NonNegativeInt,
  ForgeItemReferenceInput,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2DelegatedFrom,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadImportInput,
  OrchestratorMcpThreadImportResult,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SecretRef,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadImportService from "../../../orchestration-v2/ThreadImportService.ts";
import * as HandoffImport from "../../../peer/handoff/HandoffImport.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ForgeWorkItems from "../../../weave/ForgeWorkItems.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as WorkspaceProvider from "../../../project/WorkspaceProvider.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WeaveAgentConnections from "../../../weave/WeaveAgentConnections.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    SecureRandom.SecureRandom,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description: "List projects. Pages can shift.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
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
  description: "Read one project: workspace and saved scripts.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Register a project folder. `createWorkspaceRootIfMissing` creates it; a registered folder is rejected. No `workspaceRoot`: makes a git repo from `title` with README, icon, first commit (`commitError` on failure; project still exists). Clone first with `t3_project_clone` if needed.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, false);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description: "Update one project's settings. Omitted fields are unchanged.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description: "Delete one project. Nonempty needs `force: true`. Folder on disk stays.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    force: Schema.optionalKey(Schema.Boolean),
  }),
  dependencies: [...shared.dependencies, ProjectCloneTracker.ProjectCloneTracker],
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("t3_project_clone", {
  ...shared,
  description:
    "Clone a repository (`destinationPath` new or empty). Register after with `t3_project_create`, with the same `environmentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...SourceControlCloneRepositoryInput.fields,
  }),
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create one new top-level thread, bound to its workspace before the agent starts. Use `delegate_task` for child subagents. Bind a Forge item with `forgeItem`. Task in `message`. Omit `projectId`, model and modes to inherit yours (outside a thread, pass `projectId` or `scratch`); modes cannot exceed yours. After an error or lost reply, retry with the same `clientRequestId`. Follow it with `t3_thread_read` or `t3_thread_wait`. `watch` wakes you when it finishes. Mention it with its `link`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "No project: a new Scratch folder. Not with `projectId` or `workspaceStrategy`.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "'worktree': new checkout from `baseRef`. Honor a requested base: otherwise independent work starts from the default branch as `remote/branch` (e.g. `origin/main`) with `startFromOrigin: true`, and with no remote from the local default branch. Unpublished or stacked work uses its local base with `startFromOrigin: false`, the parent branch as `baseRef` when stacking. In a SlipJay repository a new workspace comes from the integration branch, named after `branch`. 'existing_worktree': bind `worktreePath`, a project worktree. 'root': project checkout, the project's default, never your worktree. Uncommitted edits are not copied.",
      }),
    ),
    forgeItem: Schema.optional(
      ForgeItemReferenceInput.annotate({
        description:
          "The Forge item this thread works on, in a repository with slipjay.json: its number or a ref such as YS-12. T3 binds the thread to its SlipJay workspace, creating one when it has none. Not with workspaceStrategy.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First prompt, after workspace preparation. Omit it and `attachments` for idle.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
    watch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Watch the new thread from this one, as watch does, starting before its first message.",
      }),
    ),
    clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
    /** Set by a linked environment launching its agent's delegated task here; ignored otherwise. */
    delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ForgeWorkItems.ForgeWorkItems,
    ManagedProjectFolders.ManagedProjectFolders,
    WorkspaceProvider.WorkspaceProvider,
    Path.Path,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    DocumentText.DocumentText,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ConnectionTool = Tool.make(WEAVE_NAMES.connectionTool, {
  ...shared,
  description:
    'Read, connect or disconnect T3\'s Weave connection, which every project in this environment shares. When connected, each Claude or Codex thread gets a `weave` MCP server that acts in Weave as that thread\'s own agent, on behalf of the person who made the delegation. The person normally connects with Settings → Browser → Weave → Connect to Weave, which signs in to Weave in their browser. Only if that is unavailable, the person creates a delegation in Weave Settings → Connections → T3 agents; ask for it with request_secret, then pass {action:"connect", origin:"https://<weave origin>", delegation:<secretRef>}. T3 keeps it in its server secret store. Disconnecting stops new Weave calls; to revoke T3\'s access, the person revokes the delegation in Weave.',
  parameters: Schema.Struct({
    action: Schema.Literals(["read", "connect", "disconnect"]),
    origin: Schema.optional(TrimmedNonEmptyString),
    delegation: Schema.optional(SecretRef),
  }),
  success: Schema.Struct({ connected: Schema.Boolean, origin: Schema.NullOr(Schema.String) }),
  dependencies: [
    ...shared.dependencies,
    SecretRequests.SecretRequests,
    WeaveAgentConnections.WeaveAgentConnections,
  ],
}).annotate(Tool.Destructive, false);

const ThreadImportTool = Tool.make("t3_thread_import", {
  ...shared,
  description:
    "Create a thread here that continues a conversation from another T3 Code environment, as when a thread is handed off to this one. The messages become the thread's history and its first run gets them as context; continuationPrompt, if given, starts that run. Retrying with the same source returns the thread the first call created. It runs within the caller's modes.",
  parameters: OrchestratorMcpThreadImportInput,
  success: OrchestratorMcpThreadImportResult,
  dependencies: [
    ...shared.dependencies,
    ThreadImportService.ThreadImportService,
    HandoffImport.HandoffImport,
    WorkspaceProvider.WorkspaceProvider,
    Digest.Digest,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForLinkedEnvironments);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ThreadImportTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
  ProjectCloneTool,
  ConnectionTool,
);
