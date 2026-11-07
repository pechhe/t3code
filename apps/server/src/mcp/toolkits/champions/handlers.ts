import { ChampionError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Champions from "../../../champions/ChampionService.ts";
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
