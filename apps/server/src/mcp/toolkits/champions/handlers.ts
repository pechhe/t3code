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
import { ChampionsToolkit } from "./tools.ts";
const isChampionError = Schema.is(ChampionError);
const failure = (error: unknown) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: isChampionError(error) ? error.message : "Champion operation unavailable.",
  });
export const handlers = {
  t3_champions_class_choices: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.classChoices(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_recommendation: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.recommendation(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_runtime_state: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.runtimeState(input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_learning_query: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.learningQuery(input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_record_learning: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.recordLearning(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_learning_search: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.learningSearch(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_learning_topics: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.learningTopics(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_learning_read: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.learningRead(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_contribute_learning: McpToolAccess.contributes(
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
        if (target === undefined)
          return yield* service
            .contributeLearning(contributor, input)
            .pipe(Effect.mapError(failure));
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
        if (Option.isNone(forwarding))
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "This environment cannot reach linked environments.",
          });
        return yield* forwarding.value.call(
          scope,
          ChampionsToolkit.tools.t3_champions_contribute_learning,
          target,
          {
            ...input,
            environmentId: target,
            forwardedFrom: {
              environmentId: scope.environmentId,
              threadId: contributor.threadId,
              threadTitle: contributor.threadTitle,
              role: contributor.role,
            },
          },
        );
      }),
  ),
  t3_champions_confirm_learning: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.confirmLearning(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_learning_note: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.noteLearning(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_start_investigation: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.startInvestigationFromOwner(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_cancel_investigation: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const service = yield* Champions.ChampionService;
      return yield* service.cancelInvestigationFromOwner(
        (yield* McpInvocationContext.McpInvocationContext).thread,
        input,
      );
    }).pipe(Effect.mapError(failure)),
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

  t3_champions_discard_proposal: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(Effect.flatMap(Champions.ChampionService, (s) => s.discardProposal(input))),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_cancel_setup: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(Effect.flatMap(Champions.ChampionService, (s) => s.cancelSetup(input))),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_complete_setup: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.completeSetup(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_list: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.list(input)).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_champions_get: McpToolAccess.reads((input) =>
    Effect.flatMap(Champions.ChampionService, (service) => service.get(input)).pipe(
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
  t3_champions_lifecycle: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Champions.ChampionService, (service) => service.setLifecycle(input)),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_setup: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(Effect.flatMap(Champions.ChampionService, (service) => service.setup(input))),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_run_check: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Champions.ChampionService, (service) => service.runCheck(input)),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_champions_propose: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Champions.ChampionService, (service) => service.propose(input)),
      ),
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
  t3_champions_finding_action: McpToolAccess.writesEnvironment(
    ({ approvalQuote, ...input }, check) =>
      check.pipe(
        Effect.flatMap((context) =>
          Effect.flatMap(Champions.ChampionService, (service) =>
            service.findingAction(input, { threadId: context.caller?.id, quote: approvalQuote }),
          ),
        ),
        Effect.mapError(failure),
      ),
  ),
  t3_champions_start_metrics_lead: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Champions.ChampionService, (service) => service.startMetricsLead(input)),
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
  t3_champions_propose_metrics: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.proposeFromSetup(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.report(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
  t3_champions_update_finding: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Champions.ChampionService;
      return yield* service.updateDelivery(scope.thread, input);
    }).pipe(Effect.mapError(failure)),
  ),
} satisfies McpToolAccess.Handlers<typeof ChampionsToolkit.tools>;
export const layer = McpToolAccess.toLayer(ChampionsToolkit, handlers);
