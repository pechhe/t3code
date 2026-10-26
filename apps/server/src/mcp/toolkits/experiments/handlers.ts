import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { unavailable } from "../../threadAccess.ts";
import { ExperimentsToolkit } from "./tools.ts";
import { ExperimentError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isExperimentError = Schema.is(ExperimentError);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
// A refusal names what the caller can change; a storage failure says only that nothing
// was kept, leaving its cause to the server log.
const failure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : !isExperimentError(error)
      ? unavailable()
      : error.reason === "persistence"
        ? new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Experiment ${error.operation} could not be stored, so nothing changed. Retry; if it fails again, the server log has the cause.`,
          })
        : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
export const handlers = {
  t3_experiments_create: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.create(input)),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_transition: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.transition(input)),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_list: McpToolAccess.reads((_input) =>
    Effect.flatMap(Experiments.ExperimentService, (service) => service.list()).pipe(
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_assignments: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Experiments.ExperimentService;
      return yield* service
        .assignments(input, {
          environmentId: scope.environmentId,
          clientSessionId: scope.client?.sessionId,
          threadId: scope.thread?.threadId,
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_experiments_report: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Experiments.ExperimentService;
      return yield* service
        .report(input, {
          environmentId: scope.environmentId,
          clientSessionId: scope.client?.sessionId,
          threadId: scope.thread?.threadId,
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_experiments_record_evidence: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* Experiments.ExperimentService;
          return yield* service.recordEvidence(
            { ...input, source: "agent" },
            {
              environmentId: scope.environmentId,
              clientSessionId: scope.client?.sessionId,
              threadId: scope.thread?.threadId,
            },
          );
        }),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_record_evaluation: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* Experiments.ExperimentService;
          return yield* service.recordEvaluation(input, {
            environmentId: scope.environmentId,
            clientSessionId: scope.client?.sessionId,
            threadId: scope.thread?.threadId,
          });
        }),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_read_evidence: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* Experiments.ExperimentService;
      return yield* service.readEvidence(input, {
        environmentId: scope.environmentId,
        clientSessionId: scope.client?.sessionId,
        threadId: scope.thread?.threadId,
      });
    }).pipe(Effect.mapError(failure)),
  ),
  t3_experiments_record_outcome: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* Experiments.ExperimentService;
          return yield* service.recordOutcome(input, {
            environmentId: scope.environmentId,
            clientSessionId: scope.client?.sessionId,
            threadId: scope.thread?.threadId,
          });
        }),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_experiments_import_historical: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.importHistorical(input)),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_work_enroll: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.enrollWork(scope, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_work_allocate: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.allocateWork(scope, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_work_evidence: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordWorkEvidence(scope, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_work_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.readWork(scope, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_work_outcome: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordWorkOutcome(scope, input).pipe(Effect.mapError(failure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ExperimentsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ExperimentsToolkit, handlers);
