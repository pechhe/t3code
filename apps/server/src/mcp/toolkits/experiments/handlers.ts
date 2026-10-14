import * as Effect from "effect/Effect";
import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
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
    Effect.flatMap(Experiments.ExperimentService, (service) => service.assignments(input)).pipe(
      Effect.mapError(unavailable),
    ),
  ),
  t3_experiments_report: McpToolAccess.reads((input) =>
    Effect.flatMap(Experiments.ExperimentService, (service) => service.report(input)).pipe(
      Effect.mapError(unavailable),
    ),
  ),
  t3_experiments_record_outcome: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(Experiments.ExperimentService, (service) => service.recordOutcome(input)),
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
});
