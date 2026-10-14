import {
  AgentExternalSession,
  AgentTaskBinding,
  type AgentTaskOutcomeInput,
  type ExperimentOutcome,
  AuthSessionId,
  CommandId,
  MessageId,
  NodeId,
  ThreadId,
  ProviderInstanceId,
  type AgentSessionAttachInput,
  OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
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

export class ExternalAgentWorkError extends Schema.TaggedError<ExternalAgentWorkError>()(
  "ExternalAgentWorkError",
  {
    reason: Schema.Literals([
      "authority",
      "environment",
      "session",
      "workspace",
      "conflict",
      "policy",
      "storage",
      "launch",
      "task",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `External agent work refused (${this.reason}).`;
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
    const run = active ?? runs[0];
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
      terminal !== undefined && projection !== undefined
        ? subagentResultForRun(projection, terminal).text
        : row.failure_reason;
    const resultStatus =
      active !== undefined || pending
        ? "running"
        : (terminalStatus ??
          (row.state === "cancelled"
            ? "cancelled"
            : row.state === "launch-unknown" || row.state === "refused"
              ? "failed"
              : "queued"));
    const assignments = (yield* storage(experiments.assignments({}))).filter(
      (assignment) =>
        assignment.unitId === `external-work:${row.session_key}:${row.work_id}` ||
        (work.binding.workUnitId !== undefined &&
          assignment.unitKind === "work" &&
          assignment.unitId === work.binding.workUnitId),
    );
    return {
      agentTask: work.binding,
      taskId,
      childThreadId: threadId,
      childRunId: runs.at(-1)?.id ?? null,
      childNodeId: run?.rootNodeId ?? taskId,
      status: resultStatus,
      workState:
        active !== undefined || pending
          ? "working"
          : terminalStatus !== null ||
              row.state === "cancelled" ||
              row.state === "launch-unknown" ||
              row.state === "refused"
            ? "result_available"
            : "working",
      hasPendingChildRuns: active !== undefined || pending,
      latestTerminalRunId: terminal?.id ?? null,
      latestTerminalStatus: terminalStatus,
      latestTerminalSummary: summary,
      latestTerminalResultContextTransferId: null,
      providerInstanceId: work.binding.effective.instanceId,
      model: work.binding.effective.model,
      summary,
      resultContextTransferId: null,
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
      sql`UPDATE external_agent_work SET state = 'cancelled', failure_reason = ${reason} WHERE task_id = ${row.task_id}`,
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
  const repoStore = Effect.fn(function* (root: string) {
    const entry = path.join(root, ".jj", "repo");
    if (yield* fs.exists(entry)) {
      const stat = yield* fs.stat(entry);
      return yield* fs.realPath(
        stat.type === "Directory"
          ? entry
          : path.resolve(root, ".jj", (yield* fs.readFileString(entry)).trim()),
      );
    }
    const result = yield* processes.run({
      command: "git",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: root,
      timeout: "10 seconds",
      maxOutputBytes: 4096,
    });
    if (result.code !== 0) return yield* new ExternalAgentWorkError({ reason: "workspace" });
    return yield* fs.realPath(result.stdout.trim());
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
          repoStore(project.value.workspaceRoot),
          repoStore(canonical),
        ]).pipe(
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
        if (
          input.externalSessionKey === undefined ||
          input.agentTask === undefined ||
          input.clientRequestId === undefined
        )
          return yield* new ExternalAgentWorkError({ reason: "session" });
        const session = yield* readSession(scope, input.externalSessionKey);
        if (
          input.agentTask.workspacePath !== session.workspacePath ||
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
            input.runtimeMode !== ceiling)
        )
          return yield* new ExternalAgentWorkError({ reason: "authority" });
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
              original.readOnly !== input.agentTask.readOnly ||
              original.demanding !== input.agentTask.demanding)
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
          const explicit =
            input.target?.model === undefined
              ? undefined
              : requestedProviders.find((p) =>
                  p.models.some((m) => m.slug === input.target?.model),
                );
          const prepared = yield* managed
            .prepare({
              request: input.agentTask,
              requestFingerprint: fingerprint,
              workspacePath: session.workspacePath,
              providers: requestedProviders,
              ceiling,
              ...(original === undefined && unit === undefined
                ? {}
                : { policyHash: original?.policyHash ?? unit!.policyHash }),
              ...(input.target?.model === undefined
                ? {}
                : {
                    selection: {
                      instanceId: explicit?.instanceId ?? ProviderInstanceId.make("unavailable"),
                      model: input.target.model,
                      options: input.target.options ?? [],
                    },
                  }),
            })
            .pipe(
              Effect.mapError((cause) => new ExternalAgentWorkError({ reason: "policy", cause })),
            );
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
            title: input.title ?? input.agentTask.role,
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
        const assignments = [
          ...(yield* storage(
            experiments.assignForTask({
              threadId,
              projectId: session.projectId,
              modelSelection: work.binding.requested,
              unitId: `external-work:${session.key}:${work.binding.workId}`,
              agentTask: work.binding,
              unitCreatedAt: DateTime.formatIso(yield* DateTime.now),
              taskLever: work.binding.role === "reviewer" ? "reviewer" : "delegation",
              taskCategory: work.binding.role,
              enrollment: "new",
            }),
          )),
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
        const validated = yield* Effect.result(
          managed.validate({
            binding: work.binding,
            selection: effective,
            providers: eligible,
            ceiling,
            workspacePath: session.workspacePath,
          }),
        );
        if (validated._tag === "Failure") {
          for (const assignment of assignments)
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
          yield* storage(
            sql`UPDATE external_agent_work SET state = 'refused', failure_reason = 'policy-refused-before-launch' WHERE task_id = ${taskId}`,
          );
          return yield* status(scope, taskId);
        }
        const launched = yield* Effect.result(
          launch.launch({
            commandId: CommandId.make(`command:external-work:${identity}`),
            threadId,
            projectId: session.projectId,
            title: work.title,
            modelSelection: effective,
            runtimeMode: ceiling,
            interactionMode: "default",
            agentTask: binding,
            workspaceStrategy: { type: "existing_worktree", worktreePath: session.workspacePath },
            initialMessage: {
              messageId: MessageId.make(`message:external-work:${identity}`),
              text: work.prompt,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
          }),
        );
        if (launched._tag === "Failure") {
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
