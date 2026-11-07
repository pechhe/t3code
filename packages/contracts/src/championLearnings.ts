import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ProjectId } from "./baseSchemas.ts";
import { AgentRole } from "./agentPolicy.ts";
import {
  ChampionId,
  ChampionLabel,
  ChampionLearningRecordInput,
  ChampionLearningRevision,
} from "./champions.ts";

/** The Champion's confirmation of a contributed revision; it never makes a new revision. */
export const ChampionLearningConfirmation = Schema.Struct({
  revisionId: ChampionLabel,
  at: IsoDateTime,
  note: ChampionLabel,
});
export type ChampionLearningConfirmation = typeof ChampionLearningConfirmation.Type;

export const ChampionLearningEntry = Schema.Struct({
  revision: ChampionLearningRevision,
  championName: ChampionLabel,
  /** The revision's own plain sentence, or the presentation note added to it later. */
  plainSummary: Schema.NullOr(ChampionLabel),
  confirmation: Schema.NullOr(ChampionLearningConfirmation),
  due: Schema.Boolean,
  earlierRevisions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ChampionLearningEntry = typeof ChampionLearningEntry.Type;

export const ChampionLearningFilter = Schema.Literals([
  "all",
  "due",
  "contributed",
  "needs-review",
]);
export type ChampionLearningFilter = typeof ChampionLearningFilter.Type;

export const ChampionLearningSearchInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  championId: Schema.optional(ChampionId),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  filter: Schema.optional(ChampionLearningFilter),
  cursor: Schema.optional(ChampionLabel),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ChampionLearningSearchInput = typeof ChampionLearningSearchInput.Type;
export const ChampionLearningSearchResult = Schema.Struct({
  learnings: Schema.Array(ChampionLearningEntry).check(Schema.isMaxLength(50)),
  total: Schema.Int,
  nextCursor: Schema.NullOr(ChampionLabel),
});
export type ChampionLearningSearchResult = typeof ChampionLearningSearchResult.Type;

export const ChampionLearningTopicsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  championId: Schema.optional(ChampionId),
});
export const ChampionLearningTopicsResult = Schema.Struct({
  topics: Schema.Array(
    Schema.Struct({
      championId: ChampionId,
      championName: ChampionLabel,
      topic: ChampionLabel,
      learnings: Schema.Int,
      latestAt: IsoDateTime,
    }),
  ).check(Schema.isMaxLength(200)),
});
export type ChampionLearningTopicsResult = typeof ChampionLearningTopicsResult.Type;

export const ChampionLearningReadInput = Schema.Struct({
  id: ChampionId,
  learningId: ChampionLabel,
});
export type ChampionLearningReadInput = typeof ChampionLearningReadInput.Type;
export const ChampionLearningReadResult = Schema.Struct({
  current: ChampionLearningEntry,
  /** Every revision of the learning, newest first, the current one included. */
  history: Schema.Array(ChampionLearningRevision).check(Schema.isMaxLength(50)),
  confirmations: Schema.Array(ChampionLearningConfirmation).check(Schema.isMaxLength(50)),
});
export type ChampionLearningReadResult = typeof ChampionLearningReadResult.Type;

/** What a linked environment passes on about the thread it forwards a contribution for. */
export const ChampionLearningForwardedFrom = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ChampionLabel,
  threadTitle: Schema.NullOr(ChampionLabel),
  role: Schema.NullOr(AgentRole),
});
export type ChampionLearningForwardedFrom = typeof ChampionLearningForwardedFrom.Type;
export const ChampionLearningContributeInput = ChampionLearningRecordInput;
export type ChampionLearningContributeInput = typeof ChampionLearningContributeInput.Type;

export const ChampionLearningConfirmInput = Schema.Struct({
  id: ChampionId,
  learningId: ChampionLabel,
  revisionId: ChampionLabel,
  note: ChampionLabel,
});
export type ChampionLearningConfirmInput = typeof ChampionLearningConfirmInput.Type;
export const ChampionLearningNoteInput = Schema.Struct({
  id: ChampionId,
  learningId: ChampionLabel,
  revisionId: ChampionLabel,
  plainSummary: ChampionLabel,
});
export type ChampionLearningNoteInput = typeof ChampionLearningNoteInput.Type;
