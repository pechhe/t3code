import {
  AgentExternalSession,
  AgentTaskBinding,
  type AgentTaskRequest,
  type AgentTaskOutcomeInput,
  type ExperimentOutcome,
  AuthSessionId,
  CommandId,
  MessageId,
  NodeId,
  type ProjectId,
  ThreadId,
  ProviderInstanceId,
  type AgentSessionAttachInput,
  OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  AGENT_ROLE_COARSE_KIND,
  isReviewerRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Experiments from "../experiments/ExperimentService.ts";
import * as Managed from "./ManagedAgentService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { clientRuntimeModeCeiling } from "../mcp/McpInvocationContext.ts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { followupBinding, followupPrompt } from "./followup.ts";
import {
  containingRepositoryStore,
  repositoryStore,
  workspaceOccupants,
} from "./workspaceIdentity.ts";
import * as ServerSettings from "../serverSettings.ts";
import { defaultChildMode, exceedsCaller } from "./delegationRuntime.ts";
import { managedTaskTitle } from "./taskTitle.ts";

export class ExternalAgentWorkError extends Schema.TaggedError<ExternalAgentWorkError>()(
  "ExternalAgentWorkError",
  {
    reason: Schema.Literals([
      "advisor-closed",
      "authority",
      "environment",
      "session",
      "workspace",
      "conflict",
      "policy",
      "source",
      "storage",
      "launch",
      "task",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "advisor-closed") return "This advisor is closed. Start a new advisor.";
    const refusal = `External agent work refused (${this.reason}).`;
    if (Schema.is(Managed.ManagedAgentError)(this.cause)) return `${refusal} ${this.cause.message}`;
    return this.reason === "source" ? `${refusal} ${Managed.sourceRevisionGuidance}` : refusal;
  }
}
export class ExternalAgentWorkService extends Context.Service<
  ExternalAgentWorkService,
  {
    readonly attach: (
      scope: McpInvocationScope,
      input: AgentSessionAttachInput,
    ) => Effect.Effect<AgentExternalSession, ExternalAgentWorkError>;
    readonly session: (
      scope: McpInvocationScope,
      key: string,
    ) => Effect.Effect<AgentExternalSession, ExternalAgentWorkError>;
    readonly submit: (
      scope: McpInvocationScope,
      input: OrchestratorMcpDelegateTaskInput,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, ExternalAgentWorkError>;
    readonly status: (
      scope: McpInvocationScope,
      taskId: NodeId,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, ExternalAgentWorkError>;
    readonly cancel: (
      scope: McpInvocationScope,
      input: OrchestratorMcpTaskCancelInput,
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, ExternalAgentWorkError>;
    readonly recordOutcome: (
      scope: McpInvocationScope,
      input: AgentTaskOutcomeInput,
    ) => Effect.Effect<ExperimentOutcome, ExternalAgentWorkError>;
  }
>()("t3/agents/ExternalAgentWorkService") {}

const Work = Schema.Struct({
  binding: AgentTaskBinding,
  prompt: Schema.String,
  title: Schema.String,
  messageId: Schema.optional(MessageId),
});
const encodeSession = Schema.encodeSync(Schema.fromJsonString(AgentExternalSession));
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentExternalSession));
const encodeWork = Schema.encodeSync(Schema.fromJsonString(Work));
const decodeWork = Schema.decodeUnknownEffect(Schema.fromJsonString(Work));
const encodeSubmission = Schema.encodeEffect(
  Schema.fromJsonString(OrchestratorMcpDelegateTaskInput),
);
type WorkRow = {
  task_id: string;
  session_key: string;
  work_id: string;
  attempt_id: string;
  request_id: string;
  thread_id: string;
  fingerprint: string;
  payload_json: string;
  state: "prepared" | "accepted" | "cancelled" | "launch-unknown" | "refused";
  failure_reason: string | null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const auth = yield* AuthSessions.AuthSessionRepository;
  const sessionStore = yield* SessionStore.SessionStore;
  const projects = yield* Projects.ProjectService;
  const providers = yield* Providers.ProviderRegistry;
  const threads = yield* Threads.ThreadManagementService;
  const launch = yield* Launch.ThreadLaunchService;
  const managed = yield* Managed.ManagedAgentService;
  const experiments = yield* Experiments.ExperimentService;
  // Serializes submission/cancellation bookkeeping, not model execution. The existing
  // command receipts and effect outbox remain the authority for launching each turn.
  const permit = yield* Semaphore.make(1);
  const watched = yield* Ref.make(new Set<string>());
  const lifetime = yield* Effect.scope;
  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new ExternalAgentWorkError({ reason: "storage", cause })),
    );
  const experimentalWork = <A, R>(
    effect: Effect.Effect<A, import("@t3tools/contracts").ExperimentError, R>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ExternalAgentWorkError({
            reason:
              cause.reason === "not-found"
                ? "authority"
                : cause.reason === "conflict"
                  ? "conflict"
                  : cause.reason === "persistence"
                    ? "storage"
                    : "policy",
            cause,
          }),
      ),
    );
  const hash = (text: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const activeClient = Effect.fn(function* (scope: McpInvocationScope, write = false) {
    if (
      scope.thread !== undefined ||
      scope.client === undefined ||
      !scope.capabilities.has("orchestration") ||
      (write && scope.client.access === "read-only")
    )
      return yield* new ExternalAgentWorkError({ reason: "authority" });
    const row = yield* storage(
      auth.getById({ sessionId: AuthSessionId.make(scope.client.sessionId) }),
    );
    const now = yield* DateTime.now;
    if (
      Option.isNone(row) ||
      row.value.revokedAt !== null ||
      row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      row.value.subject !== "mcp-client" ||
      !row.value.scopes.includes("orchestration:read") ||
      (write && !row.value.scopes.includes("orchestration:operate"))
    )
      return yield* new ExternalAgentWorkError({ reason: "authority" });
    return scope.client;
  });
  const readSession = Effect.fn(function* (scope: McpInvocationScope, key: string) {
    const client = yield* activeClient(scope);
    const rows = yield* storage(
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM external_agent_sessions WHERE session_key = ${key} AND client_session_id = ${client.sessionId}`,
    );
    if (rows[0] === undefined) return yield* new ExternalAgentWorkError({ reason: "session" });
    const session = yield* storage(decodeSession(rows[0].payload_json));
    if (session.environmentId !== scope.environmentId)
      return yield* new ExternalAgentWorkError({ reason: "environment" });
    return session;
  });
  const readWork = Effect.fn(function* (scope: McpInvocationScope, taskId: NodeId) {
    const rows = yield* storage(
      sql<WorkRow>`SELECT * FROM external_agent_work WHERE task_id = ${taskId}`,
    );
    if (rows[0] === undefined) return yield* new ExternalAgentWorkError({ reason: "task" });
    const row = rows[0];
    const session = yield* readSession(scope, row.session_key);
    return { row, session, work: yield* storage(decodeWork(row.payload_json)) };
  });
  const status = Effect.fn("ExternalAgentWorkService.status")(function* (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) {
    const { row, work } = yield* readWork(scope, taskId);
    const threadId = ThreadId.make(row.thread_id);
    const shell = yield* storage(threads.getThreadShell(threadId));
    const projection =
      shell === null
        ? undefined
        : yield* storage(
            threads.getThreadRecords(threadId, ["runs", "messages", "turnItems", "subagents"]),
          );
    const runs = projection?.runs.toSorted((a, b) => b.ordinal - a.ordinal) ?? [];
    const active = runs.find((run) => Threads.isActiveRun(run));
    const terminal = runs.find((run) =>
      ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
    );
    // Legacy rows predate the explicit message index; their launch identity already names it.
    const messageId =
      work.messageId ??
      MessageId.make(row.task_id.replace(/^node:external-work:/, "message:external-work:"));
    const consultationRuns = runs.filter((run) => run.userMessageId === messageId);
    const consultation = consultationRuns[0];
    const consultationTerminal =
      consultation !== undefined &&
      ["completed", "failed", "cancelled", "interrupted"].includes(consultation.status)
        ? consultation
        : undefined;
    const run = consultation ?? active ?? runs[0];
    const pending =
      projection?.subagents.some((task) => ["running", "pending"].includes(task.status)) ?? false;
    const terminalStatus =
      terminal?.status === "completed" ||
      terminal?.status === "failed" ||
      terminal?.status === "cancelled" ||
      terminal?.status === "interrupted"
        ? terminal.status
        : null;
    const summary =
      consultationTerminal !== undefined && projection !== undefined
        ? subagentResultForRun(projection, consultationTerminal).text
        : row.failure_reason;
    const latestSummary =
      terminal !== undefined && projection !== undefined
        ? subagentResultForRun(projection, terminal).text
        : row.failure_reason;
    const resultStatus =
      consultationTerminal !== undefined
        ? (consultationTerminal.status as "completed" | "failed" | "cancelled" | "interrupted")
        : consultation !== undefined && Threads.isActiveRun(consultation)
          ? "running"
          : row.state === "cancelled"
            ? "cancelled"
            : row.state === "launch-unknown" || row.state === "refused"
              ? "failed"
              : "queued";
    const handoffRun = consultationTerminal ?? terminal;
    const handoff =
      active === undefined && !pending && handoffRun !== undefined
        ? yield* managed
            .handoff(work.binding, {
              threadId,
              runId: handoffRun.id,
            })
            .pipe(
              Effect.orElseSucceed(() => ({
                workspacePath: work.binding.workspacePath,
                revision: null,
                quiescent: false,
              })),
            )
        : undefined;
    const assignments = (yield* storage(experiments.assignments({}))).filter(
      (assignment) =>
        assignment.unitId === `external-work:${row.session_key}:${row.work_id}` ||
        (work.binding.workUnitId !== undefined &&
          assignment.unitKind === "work" &&
          assignment.unitId === work.binding.workUnitId),
    );
    if (
      work.binding.role === "advisor" &&
      consultationTerminal !== undefined &&
      !active &&
      !pending
    ) {
      yield* storage(
        threads.dispatch({
          type: "advisor.result.observe",
          commandId: CommandId.make(`advisor-observed:${threadId}:${consultationTerminal.id}`),
          threadId,
          runId: consultationTerminal.id,
        }),
      );
    }
    return {
      agentTask: work.binding,
      ...(handoff === undefined ? {} : { handoff }),
      taskId,
      childThreadId: threadId,
      childRunId: consultation?.id ?? null,
      childNodeId: run?.rootNodeId ?? taskId,
      status: resultStatus,
      workState:
        consultationTerminal !== undefined
          ? "result_available"
          : active !== undefined || pending
            ? "working"
            : row.state === "cancelled" || row.state === "launch-unknown" || row.state === "refused"
              ? "result_available"
              : "working",
      hasPendingChildRuns: active !== undefined || pending,
      latestTerminalRunId: terminal?.id ?? null,
      latestTerminalStatus: terminalStatus,
      latestTerminalSummary: latestSummary,
      latestTerminalResultContextTransferId: null,
      providerInstanceId: work.binding.effective.instanceId,
      model: work.binding.effective.model,
      summary,
      resultContextTransferId: null,
      // An external caller has no pending-request tools to answer a question with.
      hasPendingQuestion: false,
      waitTimedOut: false,
      launchState: row.state,
      failureReason: row.failure_reason,
      assignmentIds: assignments.map((a) => a.id),
    } satisfies OrchestratorMcpDelegateTaskResult;
  });
  const stop = Effect.fn(function* (row: WorkRow, reason: string) {
    const threadId = ThreadId.make(row.thread_id);
    if ((yield* storage(threads.getThreadShell(threadId))) !== null) {
      yield* storage(
        threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${row.task_id}:cancel`),
          threadId,
          reason,
        }),
      );
      yield* storage(
        threads.stopDelegatedTasks({
          threadId,
          commandId: CommandId.make(`${row.task_id}:cancel`),
          reason,
        }),
      );
    }
    yield* storage(
      sql`UPDATE external_agent_work SET state = 'cancelled', failure_reason = ${reason} WHERE thread_id = ${row.thread_id}`,
    );
  });
  const watch = Effect.fn(function* (clientSessionId: string) {
    if ((yield* Ref.get(watched)).has(clientSessionId)) return;
    yield* Ref.update(watched, (current) => new Set([...current, clientSessionId]));
    yield* sessionStore.awaitInvalidation(AuthSessionId.make(clientSessionId)).pipe(
      Effect.andThen(
        permit
          .withPermit(
            Effect.gen(function* () {
              const rows = yield* storage(
                sql<WorkRow>`SELECT w.* FROM external_agent_work w JOIN external_agent_sessions s ON s.session_key = w.session_key WHERE s.client_session_id = ${clientSessionId} AND w.state != 'cancelled'`,
              );
              const results = yield* Effect.forEach(rows, (row) =>
                stop(row, "owner-credential-revoked-or-expired").pipe(Effect.result),
              );
              const failed = results.find((result) => result._tag === "Failure");
              if (failed?._tag === "Failure") return yield* failed.failure;
            }),
          )
          .pipe(
            Effect.tapError(() =>
              Effect.logWarning("Retrying external work cancellation after owner invalidation."),
            ),
            Effect.retry(Schedule.spaced("1 second")),
          ),
      ),
      Effect.catch(() =>
        Effect.logWarning("Unable to stop invalidated external agent work.", { clientSessionId }),
      ),
      Effect.forkIn(lifetime),
    );
  });
  const restored = yield* storage(
    sql<{
      client_session_id: string;
    }>`SELECT DISTINCT client_session_id FROM external_agent_sessions`,
  );
  for (const row of restored) yield* watch(row.client_session_id);
  const workspaceAuthority = (projectId: ProjectId, request: AgentTaskRequest, owner: string) =>
    Effect.gen(function* () {
      // Isolated helpers and pinned readers may use another workspace of the repository,
      // so both are checked against the writers there.
      if (request.workspaceAssignment !== "isolated" && request.sourceRevision === undefined)
        return {};
      const project = yield* storage(projects.getById(projectId));
      const shells = yield* storage(
        threads.listProjectThreads({ projectId, includeSubagents: true }),
      );
      return {
        owner,
        ...(Option.isNone(project) ? {} : { projectRoot: project.value.workspaceRoot }),
        occupants: workspaceOccupants(shells),
      };
    });
  const attach = (scope: McpInvocationScope, input: AgentSessionAttachInput) =>
    permit.withPermit(
      Effect.gen(function* () {
        const client = yield* activeClient(scope, true);
        if (input.environmentId !== scope.environmentId)
          return yield* new ExternalAgentWorkError({ reason: "environment" });
        const project = yield* storage(projects.getById(input.projectId));
        if (Option.isNone(project))
          return yield* new ExternalAgentWorkError({ reason: "workspace" });
        const canonical = yield* fs
          .realPath(input.workspacePath)
          .pipe(
            Effect.mapError((cause) => new ExternalAgentWorkError({ reason: "workspace", cause })),
          );
        if (!path.isAbsolute(input.workspacePath) || canonical !== input.workspacePath)
          return yield* new ExternalAgentWorkError({ reason: "workspace" });
        const stores = yield* Effect.all([
          containingRepositoryStore(project.value.workspaceRoot),
          repositoryStore(canonical),
        ]).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, processes),
          Effect.mapError((cause) => new ExternalAgentWorkError({ reason: "workspace", cause })),
        );
        if (stores[0] !== stores[1])
          return yield* new ExternalAgentWorkError({ reason: "workspace" });
        const key = yield* hash(
          `${scope.environmentId}\n${client.sessionId}\n${input.externalSessionId}`,
        );
        const session: AgentExternalSession = {
          ...input,
          key,
          clientSessionId: client.sessionId,
          ceiling: clientRuntimeModeCeiling(client),
        };
        const prior = yield* storage(
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM external_agent_sessions WHERE session_key = ${key}`,
        );
        if (prior[0] !== undefined) {
          if (prior[0].payload_json !== encodeSession(session))
            return yield* new ExternalAgentWorkError({ reason: "conflict" });
          return yield* storage(decodeSession(prior[0].payload_json));
        }
        yield* storage(
          sql`INSERT INTO external_agent_sessions (session_key, client_session_id, external_session_id, payload_json) VALUES (${key}, ${client.sessionId}, ${input.externalSessionId}, ${encodeSession(session)})`,
        );
        yield* watch(client.sessionId);
        return session;
      }),
    );
  const submit = (scope: McpInvocationScope, input: OrchestratorMcpDelegateTaskInput) =>
    permit.withPermit(
      Effect.gen(function* () {
        const client = yield* activeClient(scope, true);
        if (input.followup !== undefined) {
          const followup = input.followup;
          if (
            input.externalSessionKey === undefined ||
            input.clientRequestId === undefined ||
            input.agentTask !== undefined ||
            input.target !== undefined ||
            input.isolation !== undefined ||
            input.runtimeMode !== undefined ||
            input.interactionMode !== undefined ||
            input.offPolicyReason !== undefined ||
            input.title !== undefined ||
            input.role !== undefined
          )
            return yield* new ExternalAgentWorkError({ reason: "conflict" });
          const session = yield* readSession(scope, input.externalSessionKey);
          const original = yield* readWork(scope, followup.taskId);
          if (original.row.session_key !== session.key)
            return yield* new ExternalAgentWorkError({ reason: "authority" });
          const identity = yield* hash(`${session.key}\n${input.clientRequestId}`);
          const taskId = NodeId.make(`node:followup:${identity}`);
          const messageId = MessageId.make(`message:followup:${identity}`);
          const threadId = ThreadId.make(original.row.thread_id);
          const fingerprint = yield* hash(
            yield* encodeSubmission({ ...input, mode: undefined, timeoutMs: undefined }).pipe(
              Effect.orDie,
            ),
          );
          let row = (yield* storage(
            sql<WorkRow>`SELECT * FROM external_agent_work WHERE session_key = ${session.key} AND request_id = ${input.clientRequestId}`,
          ))[0];
          if (row !== undefined) {
            if (row.task_id !== taskId || row.fingerprint !== fingerprint)
              return yield* new ExternalAgentWorkError({ reason: "conflict" });
            if (row.state === "accepted" || row.state === "cancelled")
              return yield* status(scope, taskId);
          }
          const closed = yield* storage(
            sql<WorkRow>`SELECT * FROM external_agent_work WHERE thread_id = ${threadId} AND state = 'cancelled'`,
          );
          if (closed.length > 0 || original.row.state !== "accepted")
            return yield* new ExternalAgentWorkError({ reason: "conflict" });
          const originalThread = yield* storage(threads.getThreadRecords(threadId, []));
          if (originalThread.thread.advisorClosedAt !== undefined)
            return yield* new ExternalAgentWorkError({ reason: "advisor-closed" });
          const binding = original.work.binding;
          const ceiling = clientRuntimeModeCeiling(client);
          if (ceiling !== session.ceiling)
            return yield* new ExternalAgentWorkError({ reason: "authority" });
          if (binding.workUnitId !== undefined)
            yield* experimentalWork(
              experiments.workDispatchPolicy({
                workUnitId: binding.workUnitId,
                role: binding.role,
                followup: true,
                owner: {
                  environmentId: session.environmentId,
                  projectId: session.projectId,
                  workspacePath: session.workspacePath,
                  parentThreadId: null,
                  externalSessionKey: session.key,
                  clientSessionId: client.sessionId,
                },
              }),
            );
          const followupTarget = followupBinding(
            binding,
            followup,
            originalThread.thread.followupSourceRevision,
          );
          if (followupTarget === undefined)
            return yield* new ExternalAgentWorkError({ reason: "source" });
          const prompt = followupPrompt(followup, input.task);
          if (row === undefined) {
            const current = yield* status(scope, followup.taskId);
            if (current.hasPendingChildRuns || current.workState !== "result_available")
              return yield* new ExternalAgentWorkError({ reason: "conflict" });
            yield* storage(sql`INSERT INTO external_agent_work (task_id, session_key, work_id, attempt_id, request_id, thread_id, fingerprint, payload_json, state)
              VALUES (${taskId}, ${session.key}, ${original.row.work_id}, ${`followup:${identity}`}, ${input.clientRequestId}, ${threadId}, ${fingerprint}, ${encodeWork({ binding, prompt, title: original.work.title, messageId })}, 'prepared')`);
          }
          const attempt = Effect.gen(function* () {
            const catalog = yield* providers.getProviders;
            const eligible = yield* Effect.filter(catalog, (provider) =>
              threads.isProviderInstanceEnabledForProject({
                projectId: session.projectId,
                instanceId: provider.instanceId,
              }),
            );
            yield* managed
              .validate({
                binding: followupTarget,
                runtimeMode: originalThread.thread.runtimeMode,
                selection: binding.effective,
                projectId: session.projectId,
                providers: eligible,
                ceiling,
                workspacePath: session.workspacePath,
                ...(yield* workspaceAuthority(session.projectId, binding, session.key)),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ExternalAgentWorkError({
                      reason: cause.reason === "source" ? "source" : "policy",
                      cause,
                    }),
                ),
              );
            yield* threads
              .sendToThread({
                projectId: session.projectId,
                threadId,
                messageId,
                ...(followup.sourceRevision === undefined
                  ? {}
                  : { followupSourceRevision: followup.sourceRevision }),
                externalWorkOwner: {
                  environmentId: session.environmentId,
                  projectId: session.projectId,
                  externalSessionKey: session.key,
                  clientSessionId: client.sessionId,
                  ceiling,
                },
                commandId: CommandId.make(`command:followup:${identity}`),
                text: prompt,
                attachments: [],
                mode: "queue",
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(
                Effect.mapError((cause) => new ExternalAgentWorkError({ reason: "launch", cause })),
              );
            yield* storage(
              sql`UPDATE external_agent_work SET state = 'accepted', failure_reason = NULL WHERE task_id = ${taskId}`,
            );
            return yield* status(scope, taskId);
          });
          return yield* managed.exclusive(attempt);
        }
        if (
          input.externalSessionKey === undefined ||
          input.agentTask === undefined ||
          input.clientRequestId === undefined
        )
          return yield* new ExternalAgentWorkError({ reason: "session" });
        const session = yield* readSession(scope, input.externalSessionKey);
        // The session's workspace is the lead's; an isolated helper workspace is validated
        // against it by the managed service, under the same accountable session.
        if (
          ((input.agentTask.workspaceAssignment ?? "lead") === "lead" &&
            input.agentTask.workspacePath !== session.workspacePath) ||
          input.interactionMode === "plan"
        )
          return yield* new ExternalAgentWorkError({ reason: "workspace" });
        const unitOwner = {
          environmentId: session.environmentId,
          projectId: session.projectId,
          workspacePath: session.workspacePath,
          parentThreadId: null,
          externalSessionKey: session.key,
          clientSessionId: client.sessionId,
        };
        const unit =
          input.agentTask.workUnitId === undefined
            ? undefined
            : yield* experimentalWork(
                experiments.workDispatchPolicy({
                  workUnitId: input.agentTask.workUnitId,
                  owner: unitOwner,
                  role: input.agentTask.role,
                }),
              );
        // The registered ceiling is immutable; re-authentication never adopts another
        // client's old work. Revoked/expired credentials cannot submit or resume it.
        const ceiling = clientRuntimeModeCeiling(client);
        if (
          ceiling !== session.ceiling ||
          (input.runtimeMode !== undefined &&
            input.runtimeMode !== "inherit" &&
            exceedsCaller(input.runtimeMode, ceiling))
        )
          return yield* new ExternalAgentWorkError({ reason: "authority" });
        const configuredMode = (yield* storage(serverSettings.getSettings)).delegation
          .defaultChildRuntimeMode;
        const runtimeMode =
          input.runtimeMode === undefined || input.runtimeMode === "inherit"
            ? defaultChildMode(ceiling, configuredMode)
            : input.runtimeMode;
        // Request content is hashed below with its full typed wire schema; wait budgets
        // do not change a launch identity.
        const wire = yield* encodeSubmission({
          ...input,
          mode: undefined,
          timeoutMs: undefined,
          clientRequestId: undefined,
        }).pipe(Effect.orDie);
        const fingerprint = yield* hash(wire);
        const identity = yield* hash(
          `${session.key}\n${input.agentTask.workId}\n${input.agentTask.attemptId}`,
        );
        const taskId = NodeId.make(`node:external-work:${identity}`);
        const threadId = ThreadId.make(`thread:external-work:${identity}`);
        const prior = yield* storage(
          sql<WorkRow>`SELECT * FROM external_agent_work WHERE task_id = ${taskId} OR (session_key = ${session.key} AND request_id = ${input.clientRequestId})`,
        );
        let row = prior[0];
        if (row !== undefined && (row.task_id !== taskId || row.fingerprint !== fingerprint))
          return yield* new ExternalAgentWorkError({ reason: "conflict" });
        if (row?.state === "accepted" || row?.state === "cancelled")
          return yield* status(scope, taskId);
        if (row === undefined) {
          const attempts = yield* storage(
            sql<WorkRow>`SELECT * FROM external_agent_work WHERE session_key = ${session.key} AND work_id = ${input.agentTask.workId}`,
          );
          for (const attempt of attempts)
            if (
              (yield* status(scope, NodeId.make(attempt.task_id))).hasPendingChildRuns ||
              attempt.state === "prepared" ||
              attempt.state === "launch-unknown"
            )
              return yield* new ExternalAgentWorkError({ reason: "conflict" });
          const original =
            attempts[0] === undefined
              ? undefined
              : (yield* storage(decodeWork(attempts[0].payload_json))).binding;
          if (
            original !== undefined &&
            (original.role !== input.agentTask.role ||
              original.taskClass !== input.agentTask.taskClass ||
              // A new attempt resumes the same work where it was, not in another workspace.
              original.workspacePath !== input.agentTask.workspacePath ||
              original.workspaceAssignment !== input.agentTask.workspaceAssignment ||
              original.readOnly !== input.agentTask.readOnly ||
              original.demanding !== input.agentTask.demanding ||
              (input.agentTask.executionRequirement !== undefined &&
                input.agentTask.executionRequirement !==
                  (original.executionRequirement ?? "sandbox-required")))
          )
            return yield* new ExternalAgentWorkError({ reason: "conflict" });
          const catalog = yield* providers.getProviders;
          const eligible = yield* Effect.filter(catalog, (p) =>
            threads.isProviderInstanceEnabledForProject({
              projectId: session.projectId,
              instanceId: p.instanceId,
            }),
          );
          const requestedProviders = eligible.filter(
            (p) =>
              (input.target?.providerInstanceId === undefined ||
                p.instanceId === input.target.providerInstanceId) &&
              (input.target?.driverKind === undefined || p.driver === input.target.driverKind),
          );
          const prepared = yield* managed
            .prepare({
              request:
                original === undefined
                  ? input.agentTask
                  : {
                      ...input.agentTask,
                      executionRequirement:
                        original.executionBoundary === undefined
                          ? "sandbox-required"
                          : (original.executionRequirement ?? "sandbox-required"),
                    },
              runtimeMode,
              projectId: session.projectId,
              requestFingerprint: fingerprint,
              workspacePath: session.workspacePath,
              ...(yield* workspaceAuthority(session.projectId, input.agentTask, session.key)),
              providers: requestedProviders,
              ceiling,
              ...(original === undefined && unit === undefined
                ? {}
                : { policyHash: original?.policyHash ?? unit!.policyHash }),
              ...(input.target?.model === undefined
                ? {}
                : {
                    selection: {
                      ...(input.target.providerInstanceId === undefined
                        ? {}
                        : { instanceId: input.target.providerInstanceId }),
                      model: input.target.model,
                      ...(input.target.options === undefined
                        ? {}
                        : { options: input.target.options }),
                    },
                  }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ExternalAgentWorkError({
                    reason: cause.reason === "source" ? "source" : "policy",
                    cause,
                  }),
              ),
            );
          if (
            original?.executionBoundary !== undefined &&
            original.executionBoundary !== prepared.binding.executionBoundary
          )
            return yield* new ExternalAgentWorkError({ reason: "conflict" });
          const binding = {
            ...prepared.binding,
            externalOwner: {
              environmentId: session.environmentId,
              clientSessionId: client.sessionId,
              externalSessionKey: session.key,
              projectId: session.projectId,
              ceiling,
            },
          };
          const work = {
            binding,
            prompt: `${prepared.brief}\n\n${input.task}`,
            title: managedTaskTitle(input.agentTask.role, input.task, input.title),
            messageId: MessageId.make(`message:external-work:${identity}`),
          };
          yield* storage(sql`INSERT INTO external_agent_work (task_id, session_key, work_id, attempt_id, request_id, thread_id, fingerprint, payload_json, state)
        VALUES (${taskId}, ${session.key}, ${input.agentTask.workId}, ${input.agentTask.attemptId}, ${input.clientRequestId}, ${threadId}, ${fingerprint}, ${encodeWork(work)}, 'prepared')`);
          row = (yield* storage(
            sql<WorkRow>`SELECT * FROM external_agent_work WHERE task_id = ${taskId}`,
          ))[0];
        }
        if (row === undefined) return yield* new ExternalAgentWorkError({ reason: "storage" });
        const work = yield* storage(decodeWork(row.payload_json));
        const catalog = yield* providers.getProviders;
        const eligible = yield* Effect.filter(catalog, (p) =>
          threads.isProviderInstanceEnabledForProject({
            projectId: session.projectId,
            instanceId: p.instanceId,
          }),
        );
        const taskAssignments = yield* storage(
          experiments.assignForTask({
            threadId,
            projectId: session.projectId,
            modelSelection: work.binding.requested,
            unitId: `external-work:${session.key}:${work.binding.workId}`,
            agentTask: work.binding,
            unitCreatedAt: DateTime.formatIso(yield* DateTime.now),
            taskLever: isReviewerRole(work.binding.role) ? "reviewer" : "delegation",
            taskCategory: AGENT_ROLE_COARSE_KIND[work.binding.role],
            enrollment: "new",
          }),
        );
        const assignments = [
          ...taskAssignments,
          ...(unit === undefined
            ? []
            : (yield* storage(experiments.assignments({}))).filter((a) =>
                unit.assignmentIds.includes(a.id),
              )),
        ];
        const assigned = assignments.find((a) => a.variant.modelSelection !== undefined)?.variant
          .modelSelection;
        const effective = assigned ?? work.binding.requested;
        const binding = { ...work.binding, assigned: assigned ?? null, effective };
        yield* storage(
          sql`UPDATE external_agent_work SET payload_json = ${encodeWork({ ...work, binding })} WHERE task_id = ${taskId}`,
        );
        if (unit !== undefined)
          yield* experimentalWork(
            experiments.registerWorkTask({
              workUnitId: unit.id,
              owner: unitOwner,
              binding,
              taskId,
              threadId,
            }),
          );
        // Validation and launch hold the workspace lock together, so the occupancy they
        // checked is still true when the child thread appears.
        const attempt = Effect.gen(function* () {
          const validated = yield* Effect.result(
            managed.validate({
              binding: work.binding,
              runtimeMode,
              selection: effective,
              projectId: session.projectId,
              providers: eligible,
              ceiling,
              workspacePath: session.workspacePath,
              ...(yield* workspaceAuthority(session.projectId, work.binding, session.key)),
            }),
          );
          if (validated._tag === "Failure") return { validated, launched: undefined };
          const launched = yield* Effect.result(
            launch.launch({
              commandId: CommandId.make(`command:external-work:${identity}`),
              threadId,
              projectId: session.projectId,
              title: work.title,
              modelSelection: effective,
              runtimeMode,
              interactionMode: "default",
              agentTask: binding,
              workspaceStrategy: {
                type: "existing_worktree",
                worktreePath: work.binding.workspacePath,
              },
              initialMessage: {
                messageId: MessageId.make(`message:external-work:${identity}`),
                text: work.prompt,
                attachments: [],
              },
              createdBy: "agent",
              creationSource: "mcp",
            }),
          );
          return { validated, launched };
        });
        const elsewhere =
          work.binding.workspaceAssignment === "isolated" ||
          work.binding.sourceRevision !== undefined;
        const { validated, launched } = yield* elsewhere ? managed.exclusive(attempt) : attempt;
        if (validated._tag === "Failure") {
          // The refused child fails its own task assignment, not the work unit's.
          for (const assignment of taskAssignments)
            yield* storage(
              experiments.recordOutcome({
                id: `${assignment.id}:dispatch-failure:${taskId}`,
                assignmentId: assignment.id,
                runId: null,
                kind: "failure",
                source: "independent-evidence",
                evidence: [`task:${taskId}`],
                note: validated.failure.message,
                actualModelSelection: null,
                fallbackReason: null,
              }),
            );
          if (unit !== undefined)
            yield* experimentalWork(experiments.recordWorkTaskLaunch({ taskId, state: "refused" }));
          yield* storage(
            sql`UPDATE external_agent_work SET state = 'refused', failure_reason = 'policy-refused-before-launch' WHERE task_id = ${taskId}`,
          );
          return yield* status(scope, taskId);
        }
        if (launched === undefined) return yield* new ExternalAgentWorkError({ reason: "storage" });
        if (launched._tag === "Failure") {
          // The caller only sees "launch"; the cause stays in the server log for the operator.
          yield* Effect.logWarning("External agent work launch failed before acceptance.", {
            taskId,
            cause: launched.failure,
          });
          yield* storage(
            sql`UPDATE external_agent_work SET state = 'launch-unknown', failure_reason = 'launch-response-unavailable-retry-same-attempt' WHERE task_id = ${taskId}`,
          );
          return yield* new ExternalAgentWorkError({ reason: "launch", cause: launched.failure });
        }
        yield* storage(
          sql`UPDATE external_agent_work SET state = 'accepted', failure_reason = NULL WHERE task_id = ${taskId}`,
        );
        return yield* status(scope, taskId);
      }),
    );
  return ExternalAgentWorkService.of({
    attach,
    session: readSession,
    submit,
    status,
    recordOutcome: (scope, input) =>
      permit.withPermit(
        Effect.gen(function* () {
          yield* activeClient(scope, true);
          const { row, work } = yield* readWork(scope, input.taskId);
          const assignment = (yield* storage(experiments.assignments({}))).find(
            (assignment) =>
              assignment.id === input.outcome.assignmentId &&
              (assignment.unitId === `external-work:${row.session_key}:${row.work_id}` ||
                (work.binding.workUnitId !== undefined &&
                  assignment.unitKind === "work" &&
                  assignment.unitId === work.binding.workUnitId)),
          );
          if (assignment === undefined)
            return yield* new ExternalAgentWorkError({ reason: "authority" });
          if (input.outcome.runId !== null) {
            const records = yield* storage(
              threads.getThreadRecords(ThreadId.make(row.thread_id), ["runs"]),
            );
            if (!records.runs.some((run) => run.id === input.outcome.runId))
              return yield* new ExternalAgentWorkError({ reason: "authority" });
          }
          // The external parent supplies this claim. T3 cannot attest independent
          // acceptance or telemetry merely because an authenticated caller says so.
          return yield* storage(
            experiments.recordOutcome({ ...input.outcome, source: "self-report" }),
          );
        }),
      ),
    cancel: (scope, input) =>
      permit.withPermit(
        Effect.gen(function* () {
          yield* activeClient(scope, true);
          const { row } = yield* readWork(scope, input.taskId);
          yield* stop(row, "cancelled-by-owner");
          const result = yield* status(scope, input.taskId);
          return {
            taskId: input.taskId,
            status:
              result.status === "running" || result.status === "queued"
                ? "cancel_requested"
                : result.status,
          };
        }),
      ),
  });
});
export const layer = Layer.effect(ExternalAgentWorkService, make);
