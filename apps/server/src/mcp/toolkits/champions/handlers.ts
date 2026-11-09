import {
  ChampionError,
  isLeafAgentTask,
  type ChampionLearningContributor,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Champions from "../../../champions/ChampionService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
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
const FINDING_DECISION_ACTIONS: ReadonlySet<string> = new Set([
  "dismiss",
  "reopen",
  "decision",
  "resolve_decision",
]);
const isFindingDecisionAction = (
  action: string,
): action is "dismiss" | "reopen" | "decision" | "resolve_decision" =>
  FINDING_DECISION_ACTIONS.has(action);
export const handlers = {
  t3_champions_class_choices: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.classChoices(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.client?.access === "peer-threads" && input.include !== undefined)
        return yield* peerRefused("read runtime state or a retained recommendation");
      const service = yield* Champions.ChampionService;
      if (input.include === undefined) return yield* service.get({ id: input.id });
      if (input.include === "runtime_state") return yield* service.runtimeState({ id: input.id });
      if (
        input.findingId === undefined ||
        input.findingAttemptId === undefined ||
        input.recommendationId === undefined
      )
        return yield* missing(
          "t3_champions_get",
          "findingId, findingAttemptId and recommendationId",
        );
      return yield* service.recommendation({
        id: input.id,
        findingId: input.findingId,
        findingAttemptId: input.findingAttemptId,
        recommendationId: input.recommendationId,
      });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_control: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
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
            case "setup":
              return service.setup({ id: input.id });
            case "cancel_setup":
              return service.cancelSetup({ id: input.id });
            case "discard_proposal":
              return service.discardProposal({ id: input.id });
          }
        }),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_proposal: McpToolAccess.either(
    (input) => input.action === "edit",
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        yield* check;
        if (input.id === undefined || input.metrics === undefined || input.reason === undefined)
          return yield* missing("t3_champions_proposal", "id, metrics and reason with action edit");
        const service = yield* Champions.ChampionService;
        return yield* service.propose({
          id: input.id,
          metrics: input.metrics,
          reason: input.reason,
        });
      }).pipe(Effect.mapError(failure)),
    ),
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        if (input.metrics === undefined || input.reason === undefined)
          return yield* missing("t3_champions_proposal", "metrics and reason with action submit");
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* Champions.ChampionService;
        return yield* service.proposeFromSetup(scope.thread, {
          metrics: input.metrics,
          reason: input.reason,
        });
      }).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_champions_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      if (
        input.samples !== undefined ||
        input.findings !== undefined ||
        input.journeys !== undefined
      ) {
        if (
          input.samples === undefined ||
          input.findings === undefined ||
          input.summary === undefined
        )
          return yield* missing(
            "t3_champions_report",
            "samples, findings and summary to complete a check",
          );
        return yield* service.report(scope.thread, {
          samples: input.samples,
          findings: input.findings,
          summary: input.summary,
          ...(input.journeys === undefined ? {} : { journeys: input.journeys }),
        });
      }
      if (input.summary === undefined)
        return yield* missing(
          "t3_champions_report",
          "samples, findings and summary to complete a check, or a summary alone to complete a setup",
        );
      return yield* service.completeSetup(scope.thread, { summary: input.summary });
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
        const caller = yield* ThreadAccess.readCaller();
        if (isLeafAgentTask(caller.caller?.agentTask))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A delegated worker may search learnings but not retain a retrieval receipt.",
          });
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
          if (
            forwardedFrom === undefined ||
            isLeafAgentTask(forwardedFrom.role === null ? undefined : { role: forwardedFrom.role })
          )
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "A linked environment passes on contributions only for an orchestrating thread it authenticated.",
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
  t3_champions_investigation: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      const thread = (yield* McpInvocationContext.McpInvocationContext).thread;
      if (input.action === "start") {
        if (
          input.id === undefined ||
          input.findingId === undefined ||
          input.investigationId === undefined ||
          input.question === undefined ||
          input.topic === undefined ||
          input.retrievalReceiptId === undefined ||
          input.alternatives === undefined
        )
          return yield* missing(
            "t3_champions_investigation",
            "id, findingId, investigationId, question, topic, retrievalReceiptId and alternatives with action start",
          );
        return yield* service.startInvestigationFromOwner(thread, {
          id: input.id,
          findingId: input.findingId,
          investigationId: input.investigationId,
          question: input.question,
          topic: input.topic,
          retrievalReceiptId: input.retrievalReceiptId,
          alternatives: input.alternatives,
        });
      }
      if (
        input.id === undefined ||
        input.investigationId === undefined ||
        input.requestId === undefined ||
        input.reason === undefined
      )
        return yield* missing(
          "t3_champions_investigation",
          "id, investigationId, requestId and reason with action cancel",
        );
      return yield* service.cancelInvestigationFromOwner(thread, {
        id: input.id,
        investigationId: input.investigationId,
        requestId: input.requestId,
        reason: input.reason,
      });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_finding_action: McpToolAccess.either(
    (input) => isFindingDecisionAction(input.action),
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        const context = yield* check;
        if (
          input.id === undefined ||
          input.findingId === undefined ||
          input.reason === undefined ||
          !isFindingDecisionAction(input.action)
        )
          return yield* missing("t3_champions_finding_action", "id, findingId and reason");
        const service = yield* Champions.ChampionService;
        return yield* service.findingAction(
          {
            id: input.id,
            findingId: input.findingId,
            action: input.action,
            ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
            ...(input.recommendationId === undefined
              ? {}
              : { recommendationId: input.recommendationId }),
            ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
            reason: input.reason,
          },
          { threadId: context.caller?.id, quote: input.approvalQuote },
        );
      }).pipe(Effect.mapError(failure)),
    ),
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        if (
          input.findingId === undefined ||
          input.evidence === undefined ||
          isFindingDecisionAction(input.action)
        )
          return yield* missing(
            "t3_champions_finding_action",
            "findingId and evidence for a delivery or verification action",
          );
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* Champions.ChampionService;
        return yield* service.updateDelivery(scope.thread, {
          findingId: input.findingId,
          action: input.action,
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          ...(input.revision === undefined ? {} : { revision: input.revision }),
          ...(input.specUrl === undefined ? {} : { specUrl: input.specUrl }),
          evidence: input.evidence,
        });
      }).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_champions_synthesize: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.synthesize(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
  ),

  t3_champions_learning_read: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.learningRead(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_list: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.list(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_history: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.history(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_upsert: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(Effect.flatMap(Champions.ChampionService, (service) => service.upsert(input))),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_accept: McpToolAccess.writesEnvironment(({ approvalQuote, ...input }, check) =>
    check.pipe(
      Effect.flatMap((context) =>
        Effect.flatMap(Champions.ChampionService, (service) =>
          service.accept(input, { threadId: context.caller?.id, quote: approvalQuote }),
        ),
      ),
      Effect.mapError(failure),
    ),
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
