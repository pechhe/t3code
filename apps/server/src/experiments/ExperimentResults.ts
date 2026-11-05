import type {
  ExperimentAdoptInput,
  ExperimentAdoption,
  ExperimentAssignmentReport,
  ExperimentMeasure,
  ExperimentReport,
  ExperimentResultSource,
  ExperimentResults as ExperimentResultsValue,
  ExperimentResultsInput,
  ExperimentSampleResult,
  ExperimentVariantResults,
  Experiment,
} from "@t3tools/contracts";
import { ExperimentError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AgentPolicySettings from "../agents/AgentPolicySettingsService.ts";
import * as ForgeSpecOfThread from "../weave/ForgeSpecOfThread.ts";
import * as WeaveAgentConnections from "../weave/WeaveAgentConnections.ts";
import * as ExperimentService from "./ExperimentService.ts";

/** Below this many results a variant warns; a chosen guide, not a statistical test. */
export const ENOUGH_PER_VARIANT = 20;
const LANDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RESULTS_KEPT_MS = 30_000;
const FORGE_READS = 4;

const ForgeRun = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  recordedAt: Schema.String,
  review: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        scope: Schema.optional(Schema.String),
        coverage: Schema.optional(Schema.NullOr(Schema.String)),
        findings: Schema.Array(Schema.Struct({ ref: Schema.String, severity: Schema.String })),
      }),
    ),
  ),
  dispositions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        findingRef: Schema.String,
        decision: Schema.String,
        decidedAt: Schema.String,
      }),
    ),
  ),
});
export type ForgeRun = typeof ForgeRun.Type;
const RunsPage = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  hasMore: Schema.Boolean,
  nextOffset: Schema.NullOr(Schema.Number),
});
const RunStub = Schema.Struct({ index: Schema.Number, bytes: Schema.Number });
const RunChunk = Schema.Struct({
  content: Schema.String,
  nextCursor: Schema.NullOr(Schema.String),
});
const ForgeNote = Schema.Struct({
  id: Schema.String,
  specId: Schema.String,
  kind: Schema.String,
  raisedAt: Schema.String,
});
export type ForgeNote = typeof ForgeNote.Type;
const ForgeAttempt = Schema.Struct({
  operationId: Schema.String,
  repairsOperationId: Schema.NullOr(Schema.String),
  events: Schema.Array(Schema.Struct({ event: Schema.String, occurredAt: Schema.String })),
});
export type ForgeAttempt = typeof ForgeAttempt.Type;

export interface ForgeRecord {
  readonly runs: ReadonlyArray<ForgeRun>;
  readonly notes: ReadonlyArray<ForgeNote>;
  readonly attempts: ReadonlyArray<ForgeAttempt>;
}

export interface ForgeScore {
  readonly confirmedBlockers: number | null;
  readonly falsePositives: number | null;
  readonly sentBack: number | null;
  readonly problemsAfterLanding: number | null;
  readonly landingWindowComplete: boolean | null;
  readonly sources: ReadonlyArray<ExperimentResultSource>;
}

const publishedAt = (attempt: ForgeAttempt) =>
  attempt.events.find((event) => event.event === "published")?.occurredAt;

/**
 * Score one sample from what Forge holds now, so a changed disposition replaces the old result
 * rather than adding to it. A review before landing counts as found; one after counts as a problem
 * after landing, so one finding is never both. A later disposition wins over an earlier one.
 */
export const scoreForgeRecord = (input: {
  readonly record: ForgeRecord;
  readonly since: string;
  readonly now: string;
  readonly reviewScope?: string | undefined;
  readonly measuresReviews: boolean;
}): ForgeScore => {
  const since = Date.parse(input.since);
  const published = input.record.attempts
    .flatMap((attempt) => {
      const at = publishedAt(attempt);
      return at === undefined ? [] : [{ attempt, at: Date.parse(at) }];
    })
    .filter((entry) => entry.at >= since)
    .sort((a, b) => a.at - b.at);
  const landedAt = published[0]?.at ?? null;
  const reviews = input.record.runs.filter(
    (run) =>
      run.kind === "review" &&
      Date.parse(run.recordedAt) >= since &&
      run.review != null &&
      (input.reviewScope === undefined || run.review.scope === input.reviewScope),
  );
  const sources: ExperimentResultSource[] = [];
  let confirmedBlockers = 0;
  let falsePositives = 0;
  let problemsFromFindings = 0;
  for (const run of reviews) {
    const recordedAt = Date.parse(run.recordedAt);
    const afterLanding = landedAt !== null && recordedAt > landedAt;
    const withinWindow = afterLanding && recordedAt <= landedAt + LANDING_WINDOW_MS;
    for (const finding of run.review?.findings ?? []) {
      const decision = (run.dispositions ?? [])
        .filter((entry) => entry.findingRef === finding.ref)
        .toSorted((a, b) => a.decidedAt.localeCompare(b.decidedAt))
        .at(-1)?.decision;
      const source = {
        origin: "forge-finding",
        reference: run.id,
        findingRef: finding.ref,
      } as const;
      if (decision === "reject") {
        falsePositives += 1;
        sources.push({ ...source, measure: "false-positive" });
      } else if (finding.severity === "blocking" && withinWindow) {
        problemsFromFindings += 1;
        sources.push({ ...source, measure: "problem-after-landing" });
      } else if (finding.severity === "blocking" && decision === "fix" && !afterLanding) {
        confirmedBlockers += 1;
        sources.push({ ...source, measure: "confirmed-blocker" });
      }
    }
  }
  const repairs =
    landedAt === null
      ? []
      : published.filter(
          ({ attempt, at }) =>
            attempt.repairsOperationId !== null && at <= landedAt + LANDING_WINDOW_MS,
        );
  for (const { attempt } of repairs)
    sources.push({
      measure: "problem-after-landing",
      origin: "forge-landing",
      reference: attempt.operationId,
    });
  const sendBacks = input.record.notes.filter(
    (note) => note.kind === "send_back" && Date.parse(note.raisedAt) >= since,
  );
  for (const note of sendBacks)
    sources.push({ measure: "sent-back", origin: "forge-note", reference: note.id });
  // A complete review with no findings is a real zero; no complete review knows nothing.
  const reviewed = reviews.some((run) => run.review?.coverage === "complete");
  return {
    confirmedBlockers: input.measuresReviews && reviewed ? confirmedBlockers : null,
    falsePositives: input.measuresReviews && reviewed ? falsePositives : null,
    sentBack: sendBacks.length,
    problemsAfterLanding:
      landedAt === null || !input.measuresReviews ? null : problemsFromFindings + repairs.length,
    landingWindowComplete:
      landedAt === null ? null : Date.parse(input.now) >= landedAt + LANDING_WINDOW_MS,
    sources: input.measuresReviews
      ? sources
      : sources.filter((source) => source.measure === "sent-back"),
  };
};

const knownTokens = (entry: ExperimentAssignmentReport) => {
  const { status, inputTokens, outputTokens } = entry.usage;
  // A partial total would read as a full one, so only a complete count is a result.
  return status !== "complete" || inputTokens === null || outputTokens === null
    ? null
    : inputTokens + outputTokens;
};

/** Each run past a helper's first on its thread is a further round on its work. */
const helperRounds = (entry: ExperimentAssignmentReport) => {
  const byThread = new Map<string, ExperimentAssignmentReport["runs"]>();
  for (const run of entry.runs)
    byThread.set(run.threadId, [...(byThread.get(run.threadId) ?? []), run]);
  return [...byThread.values()].flatMap((runs) =>
    runs
      .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .slice(1)
      .map((run) => run.runId),
  );
};

const handCount = (entry: ExperimentAssignmentReport, kind: string) =>
  entry.outcomes.filter((outcome) => outcome.kind === kind);

/** Pure so a report's arithmetic can be read and tested without Forge or a projection. */
export const scoreSample = (input: {
  readonly entry: ExperimentAssignmentReport;
  readonly specId: string | null;
  readonly record: ForgeRecord | null;
  readonly now: string;
}): ExperimentSampleResult => {
  const { assignment } = input.entry;
  const review = assignment.lever === "reviewer";
  const delivery = assignment.lever === "orchestration-policy" || assignment.unitKind === "work";
  const score =
    input.record === null
      ? null
      : scoreForgeRecord({
          record: input.record,
          since: assignment.assignedAt,
          now: input.now,
          reviewScope: review ? assignment.agentTask?.review?.scope : undefined,
          measuresReviews: review || delivery,
        });
  // A helper's further rounds are its own; a Spec's send-back belongs to whoever led the Spec.
  const roundsKnown =
    input.entry.projectionAvailable &&
    input.entry.missingThreadIds.length === 0 &&
    !input.entry.telemetryTruncated;
  const helper = !review && !delivery && assignment.unitKind === "task";
  const leads = new Set<string | null>(input.entry.rootThreadIds ?? [assignment.threadId]);
  const rounds = helper && roundsKnown ? helperRounds(input.entry) : null;
  const handBlockers = handCount(input.entry, "validated-finding");
  const handFalse = handCount(input.entry, "false-positive");
  const handSource = (
    outcomes: ReadonlyArray<{ readonly id: string }>,
    measure: ExperimentResultSource["measure"],
  ) => outcomes.map((o) => ({ measure, origin: "hand" as const, reference: o.id }));
  const confirmedBlockers =
    score?.confirmedBlockers ?? (handBlockers.length > 0 ? handBlockers.length : null);
  const falsePositives = score?.falsePositives ?? (handFalse.length > 0 ? handFalse.length : null);
  return {
    assignmentId: assignment.id,
    variantId: assignment.variant.id,
    threadId: assignment.threadId,
    specId: input.specId,
    tokens: knownTokens(input.entry),
    confirmedBlockers,
    falsePositives,
    sentBack: helper ? (rounds?.length ?? null) : (score?.sentBack ?? null),
    problemsAfterLanding: score?.problemsAfterLanding ?? null,
    landingWindowComplete: score?.landingWindowComplete ?? null,
    delegatedHelpers:
      delivery && roundsKnown
        ? new Set(
            input.entry.runs.map((run) => run.threadId).filter((threadId) => !leads.has(threadId)),
          ).size
        : null,
    sources: [
      ...(score?.sources ?? []),
      ...(rounds ?? []).map((reference) => ({
        measure: "sent-back" as const,
        origin: "helper-round" as const,
        reference,
      })),
      ...(score?.confirmedBlockers == null ? handSource(handBlockers, "confirmed-blocker") : []),
      ...(score?.falsePositives == null ? handSource(handFalse, "false-positive") : []),
    ],
  };
};

const measure = (values: ReadonlyArray<number | null>): ExperimentMeasure => {
  const known = values.flatMap((value) => (value === null ? [] : [value]));
  return {
    value: known.length === 0 ? null : known.reduce((total, value) => total + value, 0),
    covered: known.length,
  };
};

/** Totals over every enrolled sample, whatever happened to it. */
export const summariseVariants = (
  experiment: Pick<Experiment, "variants">,
  samples: ReadonlyArray<ExperimentSampleResult>,
): ReadonlyArray<ExperimentVariantResults> =>
  experiment.variants.map((variant) => {
    const cohort = samples.filter((sample) => sample.variantId === variant.id);
    const results = cohort.filter(
      (sample) =>
        sample.confirmedBlockers !== null ||
        sample.falsePositives !== null ||
        sample.sentBack !== null ||
        sample.tokens !== null,
    );
    return {
      variantId: variant.id,
      label: variant.label,
      enrolled: cohort.length,
      tokens: measure(cohort.map((sample) => sample.tokens)),
      confirmedBlockers: measure(cohort.map((sample) => sample.confirmedBlockers)),
      falsePositives: measure(cohort.map((sample) => sample.falsePositives)),
      sentBack: measure(cohort.map((sample) => sample.sentBack)),
      problemsAfterLanding: measure(cohort.map((sample) => sample.problemsAfterLanding)),
      landingWindowsComplete: cohort.filter((sample) => sample.landingWindowComplete === true)
        .length,
      delegatedHelpers: measure(cohort.map((sample) => sample.delegatedHelpers)),
      enteredByHand: cohort.filter((sample) =>
        sample.sources.some((source) => source.origin === "hand"),
      ).length,
      tooFewResults: results.length < ENOUGH_PER_VARIANT,
    };
  });

export class ExperimentResults extends Context.Service<
  ExperimentResults,
  {
    readonly results: (
      input: ExperimentResultsInput,
    ) => Effect.Effect<ExperimentResultsValue, ExperimentError>;
    readonly adopt: (
      input: ExperimentAdoptInput,
    ) => Effect.Effect<ExperimentAdoption, ExperimentError>;
  }
>()("t3/experiments/ExperimentResults") {}

const decodeRunsPage = Schema.decodeUnknownOption(RunsPage);
const decodeRun = Schema.decodeUnknownOption(ForgeRun);
const decodeStub = Schema.decodeUnknownOption(RunStub);
const decodeChunk = Schema.decodeUnknownOption(RunChunk);
const decodeRunJson = Schema.decodeUnknownOption(Schema.fromJsonString(ForgeRun));
const decodeAttempts = Schema.decodeUnknownOption(Schema.Array(ForgeAttempt));
const decodeNotes = Schema.decodeUnknownOption(
  Schema.Union([Schema.Array(ForgeNote), Schema.Struct({ items: Schema.Array(ForgeNote) })]),
);

const make = Effect.gen(function* () {
  const experiments = yield* ExperimentService.ExperimentService;
  const specs = yield* ForgeSpecOfThread.ForgeSpecOfThread;
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  const policy = yield* AgentPolicySettings.AgentPolicySettingsService;
  const kept = new Map<
    string,
    {
      readonly at: number;
      readonly samples: ReadonlyArray<ExperimentSampleResult>;
      readonly variants: ReadonlyArray<ExperimentVariantResults>;
      readonly forgeReadable: boolean;
    }
  >();

  const readRun = Effect.fnUntraced(function* (specId: string, item: unknown) {
    const run = decodeRun(item);
    if (Option.isSome(run)) return run.value;
    const stub = decodeStub(item);
    if (Option.isNone(stub)) return yield* Effect.fail("unreadable");
    let content = "";
    let cursor: string | null = null;
    do {
      const read = yield* weave.observe("weave_forge_runs", {
        specId,
        entry: stub.value.index,
        ...(cursor === null ? {} : { cursor }),
      });
      const chunk = decodeChunk(read.value);
      if (Option.isNone(chunk)) return yield* Effect.fail("unreadable");
      content += chunk.value.content;
      cursor = chunk.value.nextCursor;
    } while (cursor !== null);
    const whole = decodeRunJson(content);
    return Option.isSome(whole) ? whole.value : yield* Effect.fail("unreadable");
  });

  const readForge = Effect.fnUntraced(function* (specId: string) {
    const runs: ForgeRun[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const read = yield* weave.observe("weave_forge_runs", { specId, limit: 100, offset });
      const page = decodeRunsPage(read.value);
      if (Option.isNone(page)) return yield* Effect.fail("unreadable");
      for (const item of page.value.items) runs.push(yield* readRun(specId, item));
      offset = page.value.hasMore ? page.value.nextOffset : null;
    }
    const attempts = decodeAttempts(
      (yield* weave.observe("weave_forge_attempts", { itemId: specId })).value,
    );
    const notes = decodeNotes((yield* weave.observe("weave_forge_agent_notes", { specId })).value);
    if (Option.isNone(attempts) || Option.isNone(notes)) return yield* Effect.fail("unreadable");
    return {
      runs,
      attempts: attempts.value,
      notes: Array.isArray(notes.value)
        ? (notes.value as ReadonlyArray<ForgeNote>)
        : (notes.value as { readonly items: ReadonlyArray<ForgeNote> }).items,
    } satisfies ForgeRecord;
  });

  const allEntries = Effect.fnUntraced(function* (experimentId: string) {
    const entries: ExperimentReport["assignments"][number][] = [];
    let offset = 0;
    for (;;) {
      const page = yield* experiments.report({ experimentId, offset, limit: 100 });
      entries.push(...page.assignments);
      if (!page.hasMore) return { experiment: page.experiment, entries };
      offset += page.assignments.length;
    }
  });

  const compute = Effect.fn("ExperimentResults.compute")(function* (experimentId: string) {
    const { experiment, entries } = yield* allEntries(experimentId);
    const randomized = entries.filter(
      (entry) => entry.assignment.assignmentMethod === "randomized",
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    const records = new Map<string, Effect.Effect<ForgeRecord | null>>();
    let forgeReadable = true;
    const recordOf = (specId: string) =>
      Effect.suspend(() => {
        const known = records.get(specId);
        if (known !== undefined) return known;
        return Effect.cached(
          readForge(specId).pipe(
            // Forge being out of reach leaves results unknown rather than wrong, and the next
            // read recomputes from Forge, so a disconnect loses nothing.
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not read Forge for experiment results", {
                specId,
                cause,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    forgeReadable = false;
                  }),
                ),
                Effect.as(null),
              ),
            ),
          ),
        ).pipe(
          Effect.flatMap((read) => {
            records.set(specId, read);
            return read;
          }),
        );
      });
    const samples = yield* Effect.forEach(
      randomized,
      (entry) =>
        Effect.gen(function* () {
          const threadId = entry.assignment.threadId;
          const spec =
            threadId === null
              ? Option.none<ForgeSpecOfThread.ForgeSpecOfThreadResult>()
              : yield* specs.of(threadId).pipe(
                  Effect.catchCause(() =>
                    Effect.sync(() => {
                      forgeReadable = false;
                      return Option.none<ForgeSpecOfThread.ForgeSpecOfThreadResult>();
                    }),
                  ),
                );
          const specId = Option.isSome(spec) ? spec.value.specId : null;
          return scoreSample({
            entry,
            specId,
            record: specId === null ? null : yield* recordOf(specId),
            now,
          });
        }),
      { concurrency: FORGE_READS },
    );
    return {
      at: yield* Clock.currentTimeMillis,
      samples,
      variants: summariseVariants(experiment, samples),
      forgeReadable,
    };
  });

  const results: ExperimentResults["Service"]["results"] = Effect.fn("ExperimentResults.results")(
    function* (input) {
      const cached = kept.get(input.experimentId);
      const value =
        cached !== undefined && (yield* Clock.currentTimeMillis) - cached.at < RESULTS_KEPT_MS
          ? cached
          : yield* compute(input.experimentId);
      kept.set(input.experimentId, value);
      const offset = input.offset ?? 0;
      const page = value.samples.slice(offset, offset + (input.limit ?? 50));
      return {
        experimentId: input.experimentId,
        variants: value.variants,
        samples: page,
        totalSamples: value.samples.length,
        offset,
        hasMore: offset + page.length < value.samples.length,
        enoughPerVariant: ENOUGH_PER_VARIANT,
        forgeReadable: value.forgeReadable,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const refuse = (entityId: string, detail: string) =>
    new ExperimentError({ operation: "adopt", reason: "invalid-definition", entityId, detail });

  const adopt: ExperimentResults["Service"]["adopt"] = Effect.fn("ExperimentResults.adopt")(
    function* (input) {
      const experiment = (yield* experiments.list()).find((e) => e.id === input.experimentId);
      if (experiment === undefined)
        return yield* new ExperimentError({
          operation: "adopt",
          reason: "not-found",
          entityId: input.experimentId,
        });
      const variant = experiment.variants.find((candidate) => candidate.id === input.variantId);
      if (variant === undefined) return yield* refuse(input.variantId, "Unknown variant.");
      const selection = variant.modelSelection;
      if (selection !== undefined) {
        const role = experiment.eligibility.agentRoles?.[0];
        if (role === undefined || experiment.eligibility.agentRoles?.length !== 1)
          return yield* refuse(experiment.id, "This trial does not name one job to change.");
        const settings = yield* policy
          .read()
          .pipe(
            Effect.mapError(() => refuse(experiment.id, "Delegation settings are unavailable.")),
          );
        const { manifest, hash } = settings.snapshot;
        const rolePolicy = manifest.roles[role];
        if (rolePolicy === undefined)
          return yield* refuse(experiment.id, `Delegation has no ${role} job.`);
        const scope = experiment.eligibility.reviewScopes;
        const listId =
          scope?.length === 1 && scope[0] === "spec"
            ? (rolePolicy.specList ?? rolePolicy.list)
            : rolePolicy.list;
        const binding = Object.entries(manifest.models).find(
          ([, candidate]) => candidate.model === selection.model,
        );
        if (binding === undefined)
          return yield* refuse(experiment.id, `${selection.model} is not in Delegation's models.`);
        const [alias, { effortOption }] = binding;
        const effort = selection.options?.find((option) => option.id === effortOption)?.value;
        const entry = {
          model: alias,
          ...(typeof effort === "string" ? { effort } : {}),
        };
        yield* policy
          .save({
            expectedHash: hash,
            manifest: {
              ...manifest,
              lists: {
                ...manifest.lists,
                [listId]: [
                  entry,
                  ...manifest.lists[listId]!.filter((existing) => existing.model !== alias),
                ],
              },
            },
          })
          .pipe(
            Effect.mapError(() =>
              refuse(experiment.id, "Delegation settings could not be saved. Try again."),
            ),
          );
      }
      const adopted = yield* experiments.recordAdoption(input);
      kept.delete(input.experimentId);
      return {
        experiment: adopted,
        applied: selection === undefined ? ("recorded" as const) : ("delegation-setting" as const),
        nextStep:
          variant.instructions !== undefined
            ? `Add this text to ${variant.instructions.sourcePath} in agent-config and land it.`
            : variant.allocationPolicy !== undefined
              ? `Update the lead skill in agent-config to ${variant.allocationPolicy === "inline-first" ? "work inline first" : "delegate earlier"} and land it.`
              : selection === undefined
                ? "Variant keeps today's setup, so nothing needs changing."
                : null,
      };
    },
  );

  return ExperimentResults.of({ results, adopt });
});

export const layer = Layer.effect(ExperimentResults, make);
