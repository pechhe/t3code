import type {
  AgentRole,
  AgentRolesInput,
  AgentTaskClass,
  ProjectId,
  ServerProvider,
  ThreadId,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ManagedAgent from "./ManagedAgentService.ts";

/** A pick below this probability is an abstention, never an agreement. Declared before any run. */
export const SHADOW_PROBABILITY_FLOOR = 0.6;
/** How much of the task the engine reads; the rest adds cost, not information about the model. */
const TASK_TEXT_LIMIT = 6000;
const KEEP_FOR = Duration.days(90);
const RULE = { id: "delegation-model-pick", version: "1" } as const;

export interface EligibleModel {
  readonly model: string;
  readonly note?: string | undefined;
}

export interface ShadowObservation {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly role: AgentRole;
  readonly taskClass: AgentTaskClass;
  /** The models the role offered at the moment of the choice; read lazily, off the request path. */
  readonly eligible: Effect.Effect<ReadonlyArray<EligibleModel>, ManagedAgent.ManagedAgentError>;
  readonly chosenModel: string;
  /** An experiment, not the agent, decided the model that ran. */
  readonly reassigned: boolean;
  /** Sent to the decision provider and never stored. */
  readonly taskText: string;
}

/** The models a role offers now, as `agent_roles` lists them: those that can start. */
export const eligibleModels = (
  policy: ManagedAgent.ManagedAgentService["Service"],
  authority: {
    readonly projectId: ProjectId;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly ceiling: RuntimeMode;
  },
  role: { readonly role: AgentRole } & Omit<AgentRolesInput, "runtimeMode" | "model">,
) => {
  const { role: name, ...request } = role;
  return policy.roles({ ...authority, request }).pipe(
    Effect.map(
      (result) =>
        result.roles
          .find((row) => row.role === name)
          ?.models.filter((entry) => entry.available)
          .map(({ model, note }) => ({ model, note })) ?? [],
    ),
  );
};

export type ShadowStatus = "recommended" | "abstained" | "sole-model" | "failed";

/**
 * Records, beside a managed delegation, the model the decision engine would have picked from the
 * role's eligible list. It changes nothing: every failure lands in the record, never in the caller.
 */
export class DelegationModelShadow extends Context.Service<
  DelegationModelShadow,
  {
    /** Starts recording in the background and returns at once; no failure or delay reaches the caller. */
    readonly observe: (observation: ShadowObservation) => Effect.Effect<void>;
    /** The recording itself, for a caller that must await it. It fails only on an unexpected defect. */
    readonly record: (observation: ShadowObservation) => Effect.Effect<void>;
  }
>()("t3/agents/DelegationModelShadow") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Literal("model"),
    status: Schema.Literal("answered"),
    type: Schema.Literal("choice"),
    choice: Schema.String,
    selectedChoiceProbability: Schema.Number,
    confidence: Schema.optional(Schema.Number),
  }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const router = yield* DecisionRouter.DecisionRouter;

  const ask = Effect.fn("DelegationModelShadow.ask")(function* (
    observation: ShadowObservation,
    eligible: ReadonlyArray<EligibleModel>,
  ) {
    const result = yield* router.decide({
      rule: RULE,
      evidence: {
        role: observation.role,
        taskClass: observation.taskClass,
        task: observation.taskText.slice(0, TASK_TEXT_LIMIT),
      },
      questions: [
        {
          id: "model",
          type: "choice",
          instructions: `A delegating agent hands this task to its "${observation.role}" helper. Which model is best suited to do it well? Judge only from the task and each model's note.`,
          choices: eligible.map((entry, index) => ({
            label: `m${index + 1}`,
            description: entry.note === undefined ? entry.model : `${entry.model}: ${entry.note}`,
          })),
        },
      ],
    });
    const answer = result.answers.map((a) => decodeAnswer(a)).find((a) => a._tag === "Some");
    const index = answer?._tag === "Some" ? Number(answer.value.choice.slice(1)) - 1 : -1;
    const pick = eligible[index]?.model ?? null;
    const probability = answer?._tag === "Some" ? answer.value.selectedChoiceProbability : null;
    return {
      provider: result.provider,
      latencyMs: Math.round(result.latencyMs),
      pick,
      probability,
      confidence: answer?._tag === "Some" ? (answer.value.confidence ?? null) : null,
    };
  });

  const save = Effect.fn("DelegationModelShadow.save")(function* (
    observation: ShadowObservation,
    eligible: ReadonlyArray<EligibleModel>,
    status: ShadowStatus,
    fields: {
      readonly pick?: string | null;
      readonly probability?: number | null;
      readonly confidence?: number | null;
      readonly provider?: string | null;
      readonly errorCode?: string | null;
      readonly latencyMs?: number | null;
    },
  ) {
    const now = yield* DateTime.now;
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, KEEP_FOR));
    yield* sql.withTransaction(
      Effect.all([
        sql`INSERT OR IGNORE INTO delegation_model_shadow (
          recorded_at, thread_id, project_id, role, task_class, eligible_json, chosen_model,
          reassigned, status, pick_model, probability, confidence, floor, provider, error_code,
          latency_ms, brief_chars
        ) VALUES (
          ${DateTime.formatIso(now)}, ${observation.threadId}, ${observation.projectId},
          ${observation.role}, ${observation.taskClass},
          ${encodeJson(eligible.map((entry) => entry.model))}, ${observation.chosenModel},
          ${observation.reassigned ? 1 : 0}, ${status}, ${fields.pick ?? null},
          ${fields.probability ?? null}, ${fields.confidence ?? null}, ${SHADOW_PROBABILITY_FLOOR},
          ${fields.provider ?? null}, ${fields.errorCode ?? null}, ${fields.latencyMs ?? null},
          ${observation.taskText.length}
        )`,
        sql`DELETE FROM delegation_model_shadow WHERE recorded_at < ${cutoff}`,
      ]),
    );
  });

  const run = Effect.fn("DelegationModelShadow.run")(function* (observation: ShadowObservation) {
    if (!(yield* settings.getSettings).delegation.modelShadow) return;
    const seen =
      yield* sql`SELECT 1 AS seen FROM delegation_model_shadow WHERE thread_id = ${observation.threadId}`;
    if (seen.length > 0) return;
    const eligible = yield* observation.eligible;
    if (eligible.length < 2)
      return yield* save(observation, eligible, "sole-model", {
        pick: eligible[0]?.model ?? null,
      });
    const asked = yield* ask(observation, eligible).pipe(Effect.result);
    if (asked._tag === "Failure") {
      const error = asked.failure;
      return yield* save(observation, eligible, "failed", {
        errorCode:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "settings",
      });
    }
    const { pick, probability, ...rest } = asked.success;
    yield* save(
      observation,
      eligible,
      pick !== null && probability !== null && probability >= SHADOW_PROBABILITY_FLOOR
        ? "recommended"
        : "abstained",
      { pick, probability, ...rest },
    );
  });

  const record = Effect.fn("DelegationModelShadow.record")(function* (
    observation: ShadowObservation,
  ) {
    yield* run(observation).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a delegation model shadow pick.", { cause }),
      ),
    );
  });

  return DelegationModelShadow.of({
    record,
    observe: Effect.fn("DelegationModelShadow.observe")(function* (observation) {
      yield* record(observation).pipe(Effect.forkDetach);
    }),
  });
});

export const layer = Layer.effect(DelegationModelShadow, make);
