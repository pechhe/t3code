import {
  CommandId,
  type EnvironmentId,
  isDelegatedTaskThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpFailure,
  ThreadHandoffError,
  type OrchestrationV2ThreadHandoff,
  type OrchestratorMcpImportedMessage,
  type Project,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Tool from "effect/ai/Tool";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { importedThreadId } from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as PeerMcpClient from "../PeerMcpClient.ts";
import * as HandoffGit from "./HandoffGit.ts";
import { chooseRemoteProject } from "./remoteProjectChoice.ts";

/**
 * The first message on the other side: where the thread came from, and that
 * an agent resuming owned work re-establishes it from here. The move's own
 * prompt, when it names one, follows.
 */
export const continuationMessage = (input: {
  readonly fromLabel: string;
  readonly fromEnvironmentId: EnvironmentId;
  readonly fromThreadId: ThreadId;
  readonly prompt: string | undefined;
}) =>
  [
    `This thread was just moved here from ${input.fromLabel} (environment ${input.fromEnvironmentId}, thread ${input.fromThreadId}), with its conversation and its uncommitted work. The copy there is read-only now.`,
    "If your instructions say how to resume after a context rollover, follow them now: reload the workflow you were following, re-read the work item you own, and re-claim it from this thread, since claims made from the old thread still name it.",
    input.prompt ?? "Continue where it left off.",
  ].join("\n\n");

/**
 * How long a move whose import call got no clean answer waits before the other
 * side is asked again whether the thread arrived. Only an answer that old is
 * trusted to say it did not: the import may still be running there.
 */
export const UnansweredMoveRecheck = Context.Reference<Duration.Duration>(
  "t3/peer/handoff/ThreadHandoff/UnansweredMoveRecheck",
  { defaultValue: () => Duration.seconds(30) },
);

/**
 * Why `thread` cannot move now, or null. Work that wakes a thread when it ends
 * (delegated tasks, background commands, watches) would wake the copy left
 * behind, and a delegated task's own thread belongs to the parent waiting on it.
 */
export const moveBlocker = (
  thread: Pick<
    OrchestrationV2AppThread,
    "agentTask" | "lineage" | "threadWatches" | "pullRequests" | "arcRun"
  >,
  shell: Pick<OrchestrationV2ThreadShell, "pendingBackgroundTasks"> | null,
): string | null => {
  if (isDelegatedTaskThread(thread)) {
    return "A delegated task's thread stays with the thread waiting on it.";
  }
  if (thread.arcRun !== undefined && thread.arcRun.state !== "paused") {
    return "This thread is running an Arc, which T3 wakes here. Stop it first, then move the thread.";
  }
  const waking = [
    ...(shell?.pendingBackgroundTasks ?? []).map((task) =>
      task.kind === "subagent"
        ? `delegated task ${task.description ?? task.taskId}`
        : `background ${task.kind} ${task.description ?? task.taskId}`,
    ),
    ...(thread.threadWatches ?? []).map((watch) => `watch "${watch.title}"`),
    ...(thread.pullRequests ?? [])
      .filter((pullRequest) => pullRequest.watch !== undefined)
      .map((pullRequest) => `watch on pull request #${pullRequest.number}`),
  ];
  return waking.length === 0
    ? null
    : `This thread still has work that wakes it here: ${waking.join("; ")}. Let it finish or stop it, then move the thread.`;
};

/** Only a full-access link leaves a moved thread unfenced there. */
const accessReason = (link: { readonly label: string; readonly access: string }) =>
  link.access === "full-access"
    ? null
    : `The link to ${link.label} is ${link.access}; a moved thread needs full access there. Link it again with full access.`;

type HandoffState = OrchestrationV2ThreadHandoff["state"];
type DepartingHandoff = Extract<OrchestrationV2ThreadHandoff, { readonly state: "departing" }>;

/**
 * Moves a thread and its git work to a linked environment with one live copy:
 * no new turns here once it starts moving. An agent moving its own thread waits
 * for its turn to end (`pending`); a message before then cancels the move.
 */
export class ThreadHandoff extends Context.Service<
  ThreadHandoff,
  {
    /** Where the thread can go: linked environments with a project of its repository. */
    readonly options: (threadId: ThreadId) => Effect.Effect<
      ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly projectId: ProjectId | null;
        readonly reason: string | null;
        /** Projects there that fit equally; the person picks one and `start` takes its id. */
        readonly candidates?: ReadonlyArray<{
          readonly projectId: ProjectId;
          readonly title: string;
        }>;
      }>,
      ThreadHandoffError
    >;
    /**
     * Moves `threadId` to `environmentId` now. An agent moving the thread it
     * runs in (`callerThreadId`, the default target) is mid-turn, so its
     * thread moves once that turn ends. Returns the state the move is in.
     */
    readonly start: (input: {
      readonly threadId?: ThreadId | undefined;
      readonly callerThreadId?: ThreadId | undefined;
      readonly environmentId: EnvironmentId;
      readonly projectId?: ProjectId | undefined;
      readonly continuationPrompt?: string | undefined;
    }) => Effect.Effect<OrchestrationV2ThreadHandoff, ThreadHandoffError>;
    /** Cancels a move that is still waiting for the turn to end. */
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void, ThreadHandoffError>;
    /** Runs moves whose turn ended, and settles any a restart cut short. */
    readonly start_: () => Effect.Effect<void, never, Scope.Scope>;
    /** Settles one thread's move now: what the follower does when its turn ends. */
    readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/peer/handoff/ThreadHandoff") {}

/** A failure the other environment reported, carried as the move's own. */
const fromRemote = (cause: OrchestratorMcpFailure) =>
  new ThreadHandoffError({ reason: "failed", message: cause.message, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const git = yield* HandoffGit.HandoffGit;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const hereId = yield* environment.getEnvironmentId;
  /** Moves under way in this process, so a sweep never runs one twice at once. */
  const departing = new Set<ThreadId>();
  /** Moves this process began and has not yet sent the import for; only these may be released before sending. */
  const unsent = new Set<string>();
  /** When each unanswered import was sent from this process; a restart forgets, so it rechecks at once. */
  const unansweredSince = new Map<ThreadId, number>();
  const recheckAfter = yield* UnansweredMoveRecheck;

  /** The thread's agent, acting on its own behalf there through the link. */
  const scopeFor = (thread: {
    readonly id: ThreadId;
    readonly providerInstanceId: string;
  }): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: hereId,
    requestNamespace: `handoff:${thread.id}`,
    thread: {
      threadId: thread.id,
      providerSessionId: `handoff:${thread.id}`,
      providerInstanceId: thread.providerInstanceId as never,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const setHandoff = (
    threadId: ThreadId,
    expected: HandoffState | null,
    handoff: OrchestrationV2ThreadHandoff | null,
    step: string,
  ) =>
    threads
      .dispatch({
        type: "thread.handoff.update",
        commandId: CommandId.make(
          `command:handoff:${threadId}:${handoff?.handoffId ?? "clear"}:${step}`,
        ),
        threadId,
        expected,
        handoff,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) => new ThreadHandoffError({ reason: "refused", message: error.message }),
        ),
      );

  /** The project there that takes this thread, `ambiguous` when several fit equally. */
  const remoteProjectChoice = Effect.fn("ThreadHandoff.remoteProjectChoice")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) {
    const here = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    // The project's own identity reads blank while its cache is cold.
    const key =
      here === undefined
        ? undefined
        : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* new ThreadHandoffError({
        reason: "refused",
        message: "This thread's project has no repository to match there. Pick the project there.",
      });
    }
    const matches: Array<Project> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> = yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_project_list, environmentId, { cursor, limit: 100 })
        .pipe(Effect.mapError(fromRemote));
      matches.push(
        ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
      );
      cursor = listed.nextCursor;
    }
    const choice = chooseRemoteProject(matches, here);
    if (choice._tag === "none") {
      return yield* new ThreadHandoffError({
        reason: "refused",
        message: `No project there has this repository (${key}). Add it there first.`,
      });
    }
    return choice;
  });

  /** The project there to move to: the one named, or the single best match. */
  const remoteProject = Effect.fn("ThreadHandoff.remoteProject")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    requested: ProjectId | undefined,
  ) {
    if (requested !== undefined) return requested;
    const choice = yield* remoteProjectChoice(scope, environmentId, projectId);
    if (choice._tag === "chosen") return choice.project.id;
    return yield* new ThreadHandoffError({
      reason: "refused",
      message: `Several projects there have this repository; pass projectId, one of: ${choice.candidates.map((p) => `${p.title} (${p.id})`).join(", ")}.`,
    });
  });

  /** The conversation as the thread there will see it. */
  const conversation = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] }).pipe(
      Effect.map((records) =>
        records.messages
          .filter(
            (message) =>
              !message.streaming &&
              message.notification === undefined &&
              message.delegatedCompletion === undefined &&
              message.text.trim() !== "",
          )
          .slice(-2_000)
          .map((message): OrchestratorMcpImportedMessage => ({
            role: message.role === "user" ? "user" : "assistant",
            text: message.text.slice(0, 200_000),
            createdAt: DateTime.formatIso(message.createdAt),
          })),
      ),
      Effect.mapError(
        () =>
          new ThreadHandoffError({
            reason: "failed",
            message: "The conversation could not be read.",
          }),
      ),
    );

  /** Uploads the bundle there through its signed upload route. */
  const upload = Effect.fn("ThreadHandoff.upload")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    packed: HandoffGit.HandoffPackage,
  ) {
    const prepared = yield* forwarding
      .call(scope, AttachmentToolkit.tools.t3_attachment_prepare_upload, environmentId, {
        upload: {
          type: "file",
          name: `${packed.snapshot.slice(0, 12)}.bundle`,
          mimeType: "application/x-git-bundle",
          sizeBytes: packed.bundleBytes,
        },
      })
      .pipe(Effect.mapError(fromRemote));
    const resolved = yield* links
      .resolve(environmentId)
      .pipe(
        Effect.mapError(
          (error) => new ThreadHandoffError({ reason: "failed", message: error.message }),
        ),
      );
    const bytes = yield* fileSystem.readFile(packed.bundlePath).pipe(
      Effect.mapError(
        () =>
          new ThreadHandoffError({
            reason: "failed",
            message: "The bundle could not be read.",
          }),
      ),
    );
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${resolved.url}${prepared.relativeUrl}`).pipe(
          HttpClientRequest.setBody(HttpBody.uint8Array(bytes, "application/x-git-bundle")),
        ),
      )
      .pipe(
        Effect.mapError(
          () =>
            new ThreadHandoffError({
              reason: "failed",
              message: "The linked environment stopped answering mid-upload.",
            }),
        ),
      );
    if (response.status !== 204) {
      return yield* new ThreadHandoffError({
        reason: "failed",
        message: `The linked environment refused the upload (HTTP ${response.status}).`,
      });
    }
    return prepared.attachmentId;
  });

  /**
   * After an import call that did not answer cleanly: the thread it would have
   * made there, if it exists; null when the other side says it does not;
   * unknown when it cannot say.
   */
  const landedThere = Effect.fn("ThreadHandoff.landedThere")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    source: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly handoffId: string;
    },
  ) {
    const threadId = yield* importedThreadId(source).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
    return yield* forwarding.readThread(scope, environmentId, { threadId, limit: 1 }).pipe(
      Effect.as({ kind: "landed" as const, threadId }),
      Effect.catch((failure) =>
        Effect.succeed(
          failure.code === "thread_not_found"
            ? { kind: "absent" as const }
            : { kind: "unknown" as const, message: failure.message },
        ),
      ),
    );
  });

  /**
   * The move itself, from `departing`: package, send, import, then mark
   * departed. Until the import is sent, a failure releases the thread here.
   * After it, the thread here stays departing until the other side shows
   * whether the import landed, so two runnable copies never exist.
   */
  const depart = Effect.fn("ThreadHandoff.depart")(function* (
    threadId: ThreadId,
    projectHint?: ProjectId | undefined,
  ) {
    if (departing.has(threadId)) return undefined;
    departing.add(threadId);
    return yield* departOnce(threadId, projectHint).pipe(
      Effect.ensuring(Effect.sync(() => departing.delete(threadId))),
    );
  });

  const departOnce = Effect.fn("ThreadHandoff.departOnce")(function* (
    threadId: ThreadId,
    projectHint: ProjectId | undefined,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, [])
      .pipe(
        Effect.mapError(
          () =>
            new ThreadHandoffError({ reason: "not_found", message: "The thread was not found." }),
        ),
      );
    const thread = records.thread;
    const handoff = thread.handoff;
    if (handoff?.state !== "departing") return handoff;
    const scope = scopeFor(thread);
    const source = { environmentId: hereId, threadId, handoffId: handoff.handoffId };
    if (handoff.lastError !== undefined) {
      const settled = yield* recheck(threadId, handoff, scope, source);
      if (settled !== undefined) return settled;
    }
    // Unknown unless this process began the move and has not sent it: an earlier attempt's import may still land.
    let sent = handoff.lastError !== undefined || !unsent.has(handoff.handoffId);
    let importCalled = false;
    const result = yield* Effect.gen(function* () {
      const projectId = yield* remoteProject(
        scope,
        handoff.environmentId,
        thread.projectId,
        projectHint,
      );
      const project = yield* projects.getById(thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const cwd = thread.worktreePath ?? project?.workspaceRoot;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-handoff-" }).pipe(
        Effect.mapError(
          () =>
            new ThreadHandoffError({
              reason: "failed",
              message: "No temp space for the move.",
            }),
        ),
      );
      const packed =
        cwd === undefined
          ? undefined
          : yield* git.pack({ cwd, handoffId: handoff.handoffId, outDir: tempDir }).pipe(
              Effect.catchTags({
                // A thread outside git moves with its conversation only.
                HandoffNotARepositoryError: () => Effect.undefined,
              }),
              Effect.mapError(
                (error) => new ThreadHandoffError({ reason: "refused", message: error.message }),
              ),
            );
      const attachmentId =
        packed === undefined ? undefined : yield* upload(scope, handoff.environmentId, packed);
      const messages = yield* conversation(threadId);
      const descriptor = yield* environment.getDescriptor;
      sent = true;
      importCalled = true;
      unsent.delete(handoff.handoffId);
      return yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_thread_import, handoff.environmentId, {
          source,
          projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          messages,
          continuationPrompt: continuationMessage({
            fromLabel: descriptor.label,
            fromEnvironmentId: hereId,
            fromThreadId: threadId,
            prompt: handoff.continuationPrompt,
          }),
          ...(packed === undefined || attachmentId === undefined
            ? {}
            : {
                bundle: {
                  attachmentId,
                  branch: packed.branch,
                  tip: packed.tip,
                  snapshot: packed.snapshot,
                },
              }),
        })
        .pipe(Effect.mapError(fromRemote));
    }).pipe(Effect.scoped, Effect.result);
    if (result._tag === "Success")
      return yield* arrived(threadId, handoff, result.success.threadId);
    const failure = result.failure;
    if (!sent) {
      yield* failed(threadId, handoff, failure.message);
      return yield* failure;
    }
    const landed = yield* landedThere(scope, handoff.environmentId, source);
    if (landed.kind === "landed") return yield* arrived(threadId, handoff, landed.threadId);
    // A refusal ends the import there; anything else may leave it running, so ask again later.
    if (landed.kind === "absent" && importCalled && PeerMcpClient.isPeerRefusal(failure.cause)) {
      yield* failed(threadId, handoff, failure.message);
      return yield* failure;
    }
    const now = yield* Clock.currentTimeMillis;
    unansweredSince.set(threadId, now);
    yield* setHandoff(
      threadId,
      "departing",
      { ...handoff, lastError: failure.message },
      `unanswered:${now}`,
    ).pipe(Effect.ignore);
    return yield* failure;
  });

  const arrived = Effect.fn("ThreadHandoff.arrived")(function* (
    threadId: ThreadId,
    handoff: DepartingHandoff,
    there: ThreadId,
  ) {
    unansweredSince.delete(threadId);
    unsent.delete(handoff.handoffId);
    const departed: OrchestrationV2ThreadHandoff = {
      state: "departed",
      handoffId: handoff.handoffId,
      environmentId: handoff.environmentId,
      label: handoff.label,
      threadId: there,
    };
    yield* setHandoff(threadId, "departing", departed, "departed");
    return departed;
  });

  const failed = Effect.fn("ThreadHandoff.failed")(function* (
    threadId: ThreadId,
    handoff: DepartingHandoff,
    message: string,
  ) {
    unansweredSince.delete(threadId);
    unsent.delete(handoff.handoffId);
    const failure: OrchestrationV2ThreadHandoff = {
      state: "failed",
      handoffId: handoff.handoffId,
      environmentId: handoff.environmentId,
      label: handoff.label,
      lastError: message,
    };
    yield* setHandoff(threadId, "departing", failure, "failed").pipe(Effect.ignore);
    return failure;
  });

  /**
   * A move whose import got no clean answer: departed once the thread shows up
   * there, sent again with the same handoff id (undefined) once the other side,
   * given time to finish, says it never arrived, and left waiting while it cannot say.
   */
  const recheck = Effect.fn("ThreadHandoff.recheck")(function* (
    threadId: ThreadId,
    handoff: DepartingHandoff,
    scope: McpInvocationContext.McpThreadInvocationScope,
    source: Parameters<typeof landedThere>[2],
  ) {
    const since = unansweredSince.get(threadId);
    const now = yield* Clock.currentTimeMillis;
    if (since !== undefined && now - since < Duration.toMillis(recheckAfter)) return handoff;
    // Unlinking is the way out while it never answers: the user chose to give up on it.
    const linked = yield* links.list.pipe(
      Effect.map((listed) => listed.some((link) => link.environmentId === handoff.environmentId)),
      Effect.orElseSucceed(() => true),
    );
    if (!linked) {
      return yield* failed(
        threadId,
        handoff,
        `${handoff.label} was unlinked before it said whether the thread arrived. Check there for a copy.`,
      );
    }
    const landed = yield* landedThere(scope, handoff.environmentId, source);
    if (landed.kind === "landed") return yield* arrived(threadId, handoff, landed.threadId);
    return landed.kind === "absent" ? undefined : handoff;
  });

  const options: ThreadHandoff["Service"]["options"] = Effect.fn("ThreadHandoff.options")(
    function* (threadId) {
      const records = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(
          Effect.mapError(
            () =>
              new ThreadHandoffError({ reason: "not_found", message: "The thread was not found." }),
          ),
        );
      // A delegated task's thread offers no move at all; one held by work names it on every target.
      if (isDelegatedTaskThread(records.thread)) return [];
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const blocked = moveBlocker(records.thread, shell);
      const listed = yield* links.list.pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(
        listed,
        (link) => {
          const unavailable =
            blocked ??
            (link.status !== "reachable"
              ? link.status === "expired"
                ? "The link expired."
                : "Not answering right now."
              : accessReason(link));
          return unavailable !== null
            ? Effect.succeed({
                environmentId: link.environmentId,
                label: link.label,
                projectId: null,
                reason: unavailable,
              })
            : remoteProjectChoice(
                scopeFor(records.thread),
                link.environmentId,
                records.thread.projectId,
              ).pipe(
                Effect.map((choice) => ({
                  environmentId: link.environmentId,
                  label: link.label,
                  projectId: choice._tag === "chosen" ? choice.project.id : null,
                  reason: null,
                  ...(choice._tag === "ambiguous"
                    ? {
                        candidates: choice.candidates.map((project) => ({
                          projectId: project.id,
                          title: project.title,
                        })),
                      }
                    : {}),
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    environmentId: link.environmentId,
                    label: link.label,
                    projectId: null,
                    reason: error.message,
                  }),
                ),
              );
        },
        { concurrency: 4 },
      );
    },
  );

  const start: ThreadHandoff["Service"]["start"] = Effect.fn("ThreadHandoff.start")(
    function* (request) {
      const threadId = request.threadId ?? request.callerThreadId;
      if (threadId === undefined) {
        return yield* new ThreadHandoffError({
          reason: "refused",
          message: "Pass threadId: this MCP client is not running inside a T3 thread.",
        });
      }
      const input = {
        ...request,
        threadId,
        whenTurnEnds: threadId === request.callerThreadId,
      };
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(
          Effect.mapError(
            () =>
              new ThreadHandoffError({ reason: "not_found", message: "The thread was not found." }),
          ),
        );
      const thread = records.thread;
      if (thread.archivedAt !== null) {
        return yield* new ThreadHandoffError({
          reason: "refused",
          message: "Unarchive the thread to move it.",
        });
      }
      const current = thread.handoff?.state ?? null;
      if (current === "pending" || current === "departing" || current === "departed") {
        return yield* new ThreadHandoffError({
          reason: "refused",
          message: `This thread's move is already ${current}.`,
        });
      }
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const blocked = moveBlocker(thread, shell);
      if (blocked !== null) {
        return yield* new ThreadHandoffError({ reason: "refused", message: blocked });
      }
      const link = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (link === undefined) {
        return yield* new ThreadHandoffError({
          reason: "refused",
          message: "That environment is not linked.",
        });
      }
      const limited = accessReason(link);
      if (limited !== null) {
        return yield* new ThreadHandoffError({ reason: "refused", message: limited });
      }
      // Fails now, while the asking agent can still say so, rather than after its turn.
      yield* remoteProject(
        scopeFor(thread),
        input.environmentId,
        thread.projectId,
        input.projectId,
      );
      const handoffId = (yield* random.uuidV4()).replaceAll("-", "");
      const busy = records.runs.some(
        (run) =>
          run.status === "running" ||
          run.status === "starting" ||
          run.status === "waiting" ||
          run.status === "queued" ||
          run.status === "preparing",
      );
      const base = {
        handoffId,
        environmentId: input.environmentId,
        label: link.label,
        ...(input.continuationPrompt === undefined
          ? {}
          : { continuationPrompt: input.continuationPrompt }),
      };
      if (busy) {
        if (input.whenTurnEnds !== true) {
          return yield* new ThreadHandoffError({
            reason: "refused",
            message: "The thread is running a turn. Stop it, or let it move when the turn ends.",
          });
        }
        const pending: OrchestrationV2ThreadHandoff = { state: "pending", ...base };
        yield* setHandoff(input.threadId, current, pending, "pending");
        return pending;
      }
      yield* setHandoff(input.threadId, current, { state: "departing", ...base }, "departing");
      unsent.add(handoffId);
      return (yield* depart(input.threadId, input.projectId)) ?? { state: "departing", ...base };
    },
  );

  const cancel: ThreadHandoff["Service"]["cancel"] = (threadId) =>
    setHandoff(threadId, "pending", null, "cancel");

  /** A pending move whose turn ended departs; one a restart cut short is settled. */
  const settle = Effect.fn("ThreadHandoff.settle")(
    function* (threadId: ThreadId) {
      // Every run that ends comes here, and a thread's records can be gigabytes across a long
      // thread: its shell says whether it has a move at all. The sweep retries one it could not read.
      const moving = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (moving?.handoff === undefined) return;
      const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"], {
        messageRoles: ["user"],
      });
      const handoff = records.thread.handoff;
      if (handoff === undefined) return;
      if (handoff.state === "pending") {
        const live = records.runs.some(
          (run) =>
            run.status === "running" ||
            run.status === "starting" ||
            run.status === "waiting" ||
            run.status === "preparing",
        );
        if (live) return;
        // Someone wrote during the turn the agent asked in, steered into it or
        // queued after it: new instructions win. That is the user, or an agent
        // the user works through, such as an orchestrator.
        const asked = records.runs.at(-1)?.requestedAt;
        const writtenSince = records.messages.some(
          (message) => asked !== undefined && DateTime.isGreaterThan(message.createdAt, asked),
        );
        if (writtenSince || records.runs.some((run) => run.status === "queued")) {
          yield* setHandoff(threadId, "pending", null, "cancel-by-user");
          return;
        }
        // Work started during the turn would wake the copy left behind.
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const blocked = moveBlocker(records.thread, shell);
        if (blocked !== null) {
          yield* setHandoff(
            threadId,
            "pending",
            { ...handoff, state: "failed", lastError: blocked },
            "blocked",
          );
          return;
        }
        yield* setHandoff(threadId, "pending", { ...handoff, state: "departing" }, "departing");
        unsent.add(handoff.handoffId);
      }
      const now = yield* threads.getThreadRecords(threadId, []);
      if (now.thread.handoff?.state === "departing") {
        yield* depart(threadId).pipe(Effect.ignoreCause({ log: true }));
      }
    },
    Effect.ignoreCause({ log: true }),
  );

  /** Every move that is waiting on its turn or on the other side, retried. */
  const sweep = projections.getShellSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.orElseSucceed(() => []),
    Effect.flatMap((shells) =>
      Effect.forEach(
        shells.filter(
          (shell) => shell.handoff?.state === "pending" || shell.handoff?.state === "departing",
        ),
        (shell) => settle(shell.id),
        { discard: true },
      ),
    ),
  );

  const start_: ThreadHandoff["Service"]["start_"] = Effect.fn("ThreadHandoff.start_")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          // Moves a restart cut short, or that were waiting for a turn that ended meanwhile.
          yield* sweep;
          // Live events only: the sweep above covers what ended before now, and replaying the log
          // would hold millions of events in memory on a long-lived server.
          yield* threads.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                  event.payload.status,
                ),
            ),
            Stream.runForEach((event) => settle(event.threadId)),
          );
        }).pipe(Effect.ignoreCause({ log: true })),
      );
      // A move the other side never answered is checked again until it settles.
      yield* forkParked(
        Effect.repeat(sweep, Schedule.spaced(recheckAfter)).pipe(Effect.ignoreCause({ log: true })),
      );
    },
  );

  return ThreadHandoff.of({ options, start, cancel, start_, settle });
});

export const layer = Layer.effect(ThreadHandoff, make);
