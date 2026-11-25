import {
  ChampionError,
  type ChampionLearningContributor,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChampionDirectory from "../../../champions/ChampionDirectory.ts";
import type { ChampionRelay } from "../../../champions/ChampionService.ts";
import type { ForwardedChampionApproval } from "../../../champions/ChampionApproval.ts";
import * as Champions from "../../../champions/ChampionService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as DelegationLimits from "../../delegationLimits.ts";
import * as ThreadAccess from "../../threadAccess.ts";
import { ChampionsToolkit } from "./tools.ts";
const isChampionError = Schema.is(ChampionError);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message: isChampionError(error) ? error.message : "Champion operation unavailable.",
      });
const missing = (tool: string, field: string) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `This ${tool} call needs ${field}.`,
  });
const peerRefused = (what: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `A linked environment may not ${what}.`,
  });
/** Actions the repair pipeline took; refused for everyone, naming the case flow that does that work now. */
const RETIRED_FINDING_ACTIONS: ReadonlySet<string> = new Set([
  "decision",
  "diagnosis",
  "reroute",
  "spec",
]);
const isFindingAction = (
  action: string,
): action is "dismiss" | "reopen" | "verify" | "resolve_decision" =>
  !RETIRED_FINDING_ACTIONS.has(action);
const approvalRefused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const approvalRelay = Effect.fn("champions.approvalRelay")(function* (
  input: {
    readonly approvalQuote?: string | undefined;
    readonly forwardedApproval?: ForwardedChampionApproval | undefined;
  },
  threadId: ChampionRelay["threadId"],
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const proof = input.forwardedApproval;
  if (proof === undefined) return { threadId, quote: input.approvalQuote } satisfies ChampionRelay;
  const client = scope.client;
  if (
    scope.thread !== undefined ||
    client?.linked !== true ||
    client.access !== "full-access" ||
    client.senderThread === undefined ||
    client.senderThread.threadId !== proof.threadId ||
    proof.quote !== input.approvalQuote
  )
    return yield* approvalRefused(
      "forwarded_approval_untrusted: Only a full-access environment link may relay a verified approval from its calling thread.",
    );
  return {
    threadId: proof.threadId,
    quote: proof.quote,
    forwarded: {
      ...proof,
      sourceEnvironment: { id: client.senderThread.environmentId, label: client.label },
    },
  } satisfies ChampionRelay;
});
const prepareApproval = Effect.fn("champions.prepareApproval")(function* <
  P extends {
    readonly approvalQuote?: string | undefined;
    readonly forwardedApproval?: ForwardedChampionApproval | undefined;
  },
>(input: P) {
  if (input.forwardedApproval !== undefined)
    return yield* approvalRefused(
      "forwarded_approval_untrusted: A calling agent cannot supply verified approval evidence.",
    );
  if (input.approvalQuote === undefined) return input;
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const service = yield* Champions.ChampionService;
  const proof = yield* service
    .verifyApproval({ threadId: scope.thread?.threadId, quote: input.approvalQuote })
    .pipe(Effect.mapError(failure));
  return { ...input, forwardedApproval: proof };
});
export const handlers = {
  t3_champions_models: McpToolAccess.writesEnvironment(
    (input, check) =>
      check.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const service = yield* Champions.ChampionService;
            const current = yield* service.modelDefaults;
            if (input.checks === undefined && input.advice === undefined) return current;
            return yield* service.setModels({
              ...(input.checks === undefined && current.checks === undefined
                ? {}
                : { checks: input.checks ?? current.checks }),
              ...(input.advice === undefined && current.advice === undefined
                ? {}
                : { advice: input.advice ?? current.advice }),
            });
          }),
        ),
        Effect.mapError(failure),
      ),
    { linkedCallers: "allowed" },
  ),
  t3_champions_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.client?.access === "peer-threads" && input.include !== undefined)
        return yield* peerRefused("read runtime state");
      const service = yield* Champions.ChampionService;
      if (input.include === undefined) return yield* service.get({ id: input.id });
      return yield* service.runtimeState({ id: input.id });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_control: McpToolAccess.writesEnvironment(
    (input, check) =>
      check.pipe(
        // A check or setup starts an agent thread, so it obeys the delegation limit as a launch does.
        Effect.andThen(
          input.action === "run_check" || input.action === "run_review" || input.action === "setup"
            ? Effect.flatMap(ThreadAccess.loadCaller(), (caller) =>
                caller.caller === undefined
                  ? Effect.void
                  : DelegationLimits.assertBelowDelegationLimit(caller.threads, caller.caller),
              )
            : Effect.void,
        ),
        Effect.andThen(
          Effect.flatMap(Champions.ChampionService, (service) => {
            switch (input.action) {
              case "pause":
                return service.setLifecycle({ id: input.id, lifecycle: "paused" });
              case "resume":
                return service.setLifecycle({ id: input.id, lifecycle: "active" });
              case "retire":
                return service.setLifecycle({ id: input.id, lifecycle: "retired" });
              case "run_check":
                return service.runCheck({ id: input.id });
              case "run_review":
                return service.runReview({ id: input.id });
              case "setup":
                return service.setup({ id: input.id });
              case "cancel_setup":
                return service.cancelSetup({ id: input.id });
            }
          }),
        ),
        Effect.mapError(failure),
      ),
    { linkedCallers: "allowed" },
  ),
  t3_champions_metrics: McpToolAccess.either(
    (input) => input.action === "edit",
    McpToolAccess.writesEnvironment(
      (input, check) =>
        Effect.gen(function* () {
          const context = yield* check;
          const metrics = input.metrics ?? (input.retires === undefined ? undefined : []);
          if (input.id === undefined || metrics === undefined || input.reason === undefined)
            return yield* missing(
              "t3_champions_metrics",
              "id, reason, and metrics or retires with action edit",
            );
          const service = yield* Champions.ChampionService;
          return yield* service.changeMetrics(
            {
              id: input.id,
              metrics,
              ...(input.retires === undefined ? {} : { retires: input.retires }),
              reason: input.reason,
            },
            context.caller?.id,
          );
        }).pipe(Effect.mapError(failure)),
      { linkedCallers: "allowed" },
    ),
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const metrics = input.metrics ?? (input.retires === undefined ? undefined : []);
        if (metrics === undefined || input.reason === undefined)
          return yield* missing(
            "t3_champions_metrics",
            "reason, and metrics or retires with action submit",
          );
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* Champions.ChampionService;
        return yield* service.changeMetricsFromCheck(scope.thread, {
          metrics,
          ...(input.retires === undefined ? {} : { retires: input.retires }),
          reason: input.reason,
        });
      }).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_champions_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      if (input.summary === undefined)
        return yield* missing(
          "t3_champions_report",
          "a summary, with samples and findings when the check has metrics for you to measure or findings to raise",
        );
      return yield* service.submitReport(scope.thread, {
        summary: input.summary,
        ...(input.samples === undefined ? {} : { samples: input.samples }),
        ...(input.findings === undefined ? {} : { findings: input.findings }),
        ...(input.goalScore === undefined ? {} : { goalScore: input.goalScore }),
        ...(input.journeys === undefined ? {} : { journeys: input.journeys }),
      });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_learning_search: McpToolAccess.reads(
    ({ action, environmentId: _environmentId, ...input }) =>
      Effect.gen(function* () {
        const service = yield* Champions.ChampionService;
        if (action === undefined || action === "search")
          return yield* service.learningSearch(input);
        if (action === "topics") return yield* service.learningTopics(input);
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.client?.access === "peer-threads")
          return yield* peerRefused("retain a retrieval receipt");
        yield* ThreadAccess.readCaller();
        if (input.limit !== undefined && input.limit > 20)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A t3_champions_learning_search call with action query takes a limit of at most 20.",
          });
        if (input.id === undefined || input.topic === undefined)
          return yield* missing("t3_champions_learning_search", "id and topic with action query");
        return yield* service.learningQuery({
          id: input.id,
          topic: input.topic,
          ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
          ...(input.due === undefined ? {} : { due: input.due }),
          ...(input.includeSuperseded === undefined
            ? {}
            : { includeSuperseded: input.includeSuperseded }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          observations: input.observations ?? [],
        });
      }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_record_learning: McpToolAccess.contributes(
    ({ environmentId, forwardedFrom, ...input }, from) =>
      Effect.gen(function* () {
        const service = yield* Champions.ChampionService;
        if (from.kind === "link") {
          // The link authenticated the thread; a call without one is not a forwarded contribution.
          if (forwardedFrom === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "A linked environment passes on contributions only for a thread it authenticated.",
            });
          return yield* service
            .contributeLearning(
              { ...forwardedFrom, environmentLabel: from.label, linkSessionId: from.sessionId },
              input,
            )
            .pipe(Effect.mapError(failure));
        }
        if (forwardedFrom !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "forwardedFrom is set by T3 when a linked environment passes a call on. Omit it.",
          });
        const scope = from.caller.scope;
        const shell = from.caller.caller;
        const contributor = {
          environmentId: scope.environmentId,
          environmentLabel: null,
          linkSessionId: null,
          threadId: scope.thread!.threadId,
          threadTitle: shell?.title.trim().slice(0, 500) || null,
          role: shell?.agentTask?.role ?? null,
        } satisfies ChampionLearningContributor;
        const target = PeerForwarding.remoteTarget(scope, environmentId);
        if (target === undefined) {
          // Owner and contributor differ only by who is calling: the Champion's
          // own thread records its learning, any other orchestrating thread contributes.
          const doc = yield* service.get({ id: input.id }).pipe(Effect.mapError(failure));
          if (doc.champion.ownerThreadId === contributor.threadId)
            return yield* service
              .recordLearning(scope.thread!, input)
              .pipe(Effect.mapError(failure));
          return yield* service
            .contributeLearning(contributor, input)
            .pipe(Effect.mapError(failure));
        }
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
        if (Option.isNone(forwarding))
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "This environment cannot reach linked environments.",
          });
        const params = {
          ...input,
          environmentId: target,
          forwardedFrom: {
            environmentId: scope.environmentId,
            threadId: contributor.threadId,
            threadTitle: contributor.threadTitle,
            role: contributor.role,
          },
        };
        return yield* forwarding.value.call(
          scope,
          ChampionsToolkit.tools.t3_champions_record_learning,
          target,
          params,
        );
      }),
  ),
  t3_champions_confirm_learning: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      if (
        input.id === undefined ||
        input.learningId === undefined ||
        input.revisionId === undefined
      )
        return yield* missing(
          "t3_champions_confirm_learning",
          `id, learningId and revisionId with action ${input.action}`,
        );
      if (input.action === "confirm") {
        if (input.note === undefined)
          return yield* missing("t3_champions_confirm_learning", "note with action confirm");
        return yield* service.confirmLearning(scope.thread, {
          id: input.id,
          learningId: input.learningId,
          revisionId: input.revisionId,
          note: input.note,
        });
      }
      if (input.plainSummary === undefined)
        return yield* missing("t3_champions_confirm_learning", "plainSummary with action note");
      return yield* service.noteLearning(scope.thread, {
        id: input.id,
        learningId: input.learningId,
        revisionId: input.revisionId,
        plainSummary: input.plainSummary,
      });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_measurement: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.startMeasurementFromOwner(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_finding_action: McpToolAccess.beforeForwarding(
    McpToolAccess.writesEnvironment(
      (input, check) =>
        Effect.gen(function* () {
          if (!isFindingAction(input.action))
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: Champions.CASE_FLOW_REFUSAL,
            });
          const context = yield* check;
          const relay = yield* approvalRelay(input, context.caller?.id);
          if (input.id === undefined || input.findingId === undefined || input.reason === undefined)
            return yield* missing("t3_champions_finding_action", "id, findingId and reason");
          const service = yield* Champions.ChampionService;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          return yield* service.findingAction(
            {
              id: input.id,
              findingId: input.findingId,
              action: input.action,
              ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
              reason: input.reason,
            },
            relay,
            scope.thread?.threadId,
          );
        }).pipe(Effect.mapError(failure)),
      { linkedCallers: "allowed" },
    ),
    prepareApproval,
  ),
  t3_champions_learning_read: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.learningRead(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const target = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (target !== undefined) {
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        const optional = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
        const forwarding = yield* Effect.fromOption(optional).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "This environment cannot reach linked environments.",
              }),
          ),
        );
        return yield* forwarding.call(
          scope,
          ChampionsToolkit.tools.t3_champions_list,
          target,
          input,
        );
      }
      return yield* ChampionDirectory.listAcross(input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_history: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.history(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_upsert: McpToolAccess.writesEnvironment(
    (input, check) =>
      check.pipe(
        Effect.andThen(
          Effect.flatMap(Champions.ChampionService, (service) => service.upsert(input)),
        ),
        Effect.mapError(failure),
      ),
    { linkedCallers: "allowed" },
  ),
  t3_champions_check_context: McpToolAccess.readsAsCaller((_input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.checkContext(scope.thread);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_journeys_start: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.journeysStart(scope.thread);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_journey_candidate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.journeyCandidate(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_candidate_replay: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.candidateReplay(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_candidate_settle: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.candidateSettle(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_journey_record: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.journeyRecord(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof ChampionsToolkit.tools>;
export const layer = McpToolAccess.toLayer(ChampionsToolkit, handlers);
