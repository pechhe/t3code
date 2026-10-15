import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { unavailable } from "../../threadAccess.ts";
import { ExperimentsToolkit } from "./tools.ts";
export const layer = McpToolAccess.toLayer(ExperimentsToolkit, {
  t3_experiments_create: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.create(input)),
      ),
      Effect.mapError(unavailable),
    ),
  ),
  t3_experiments_transition: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.transition(input)),
      ),
      Effect.mapError(unavailable),
    ),
  ),
  t3_experiments_list: McpToolAccess.reads((_input) =>
    Effect.flatMap(Experiments.ExperimentService, (service) => service.list()).pipe(
      Effect.mapError(unavailable),
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
        .pipe(Effect.mapError(unavailable));
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
        .pipe(Effect.mapError(unavailable));
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
      Effect.mapError(unavailable),
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
      Effect.mapError(unavailable),
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
    }).pipe(Effect.mapError(unavailable)),
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
      Effect.mapError(unavailable),
    ),
  ),
  t3_experiments_import_historical: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.importHistorical(input)),
      ),
      Effect.mapError(unavailable),
    ),
  ),
  t3_work_enroll: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.enrollWork(scope, input).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_work_allocate: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.allocateWork(scope, input).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_work_evidence: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordWorkEvidence(scope, input).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_work_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.readWork(scope, input).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_work_outcome: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordWorkOutcome(scope, input).pipe(Effect.mapError(unavailable));
    }),
  ),
});
