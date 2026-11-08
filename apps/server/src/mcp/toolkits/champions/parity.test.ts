import { WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";
import { describe, expect, it } from "@effect/vitest";
import { ChampionsToolkit } from "./tools.ts";

/** Each Champion write the screen sends, and the agent tool that does the same. */
const SCREEN_WRITES_TO_TOOLS: Record<string, string> = {
  [WS_METHODS.championsUpsert]: "t3_champions_upsert",
  [WS_METHODS.championsSetLifecycle]: "t3_champions_lifecycle",
  [WS_METHODS.championsSetup]: "t3_champions_setup",
  [WS_METHODS.championsRunCheck]: "t3_champions_run_check",
  [WS_METHODS.championsPropose]: "t3_champions_propose",
  [WS_METHODS.championsDiscardProposal]: "t3_champions_discard_proposal",
  [WS_METHODS.championsCancelSetup]: "t3_champions_cancel_setup",
  [WS_METHODS.championsStartMetricsLead]: "t3_champions_start_metrics_lead",
  [WS_METHODS.championsAccept]: "t3_champions_accept",
  [WS_METHODS.championsFindingAction]: "t3_champions_finding_action",
  [WS_METHODS.championsCancelInvestigation]: "t3_champions_cancel_investigation",
};

/** Deliberate exceptions, each with its reason. */
const EXCEPTIONS: Record<string, string> = {
  // Not on the screen; agents start research only as the Champion's owner (T3-375).
  [WS_METHODS.championsStartInvestigation]: "t3_champions_start_investigation",
};

const SCREEN_READS = new Set<string>([
  WS_METHODS.championsClassChoices,
  WS_METHODS.championsRuntimeState,
  WS_METHODS.championsRecommendation,
  WS_METHODS.championsLearningQuery,
  WS_METHODS.championsLearningSearch,
  WS_METHODS.championsLearningRead,
  WS_METHODS.championsList,
  WS_METHODS.championsSubscribe,
  WS_METHODS.championsGet,
  WS_METHODS.championsHistory,
]);

/** Writes only a Champion's own runs make, from inside an authenticated setup or check. */
const RUN_ONLY_TOOLS = new Set([
  "t3_champions_record_learning",
  "t3_champions_synthesize",
  "t3_champions_complete_setup",
  "t3_champions_propose_metrics",
  "t3_champions_report",
  "t3_champions_update_finding",
  "t3_champions_confirm_learning",
  "t3_champions_learning_note",
]);

/** Agent writes with no screen command: people read learnings, agents record them (T3-444). */
const AGENT_ONLY_TOOLS = new Set([
  "t3_champions_contribute_learning",
  // A journey check's own steps: a person has no check to run them in, and a candidate has no screen.
  "t3_champions_journeys_start",
  "t3_champions_journey_candidate",
  "t3_champions_candidate_replay",
  "t3_champions_candidate_settle",
]);

const championMethods = Object.values(WS_METHODS).filter((method) =>
  method.startsWith("champions."),
);
const writeTools = Object.values(ChampionsToolkit.tools)
  .filter((tool) => !Context.get(tool.annotations, Tool.Readonly))
  .map((tool) => tool.name);

describe("Champion screen and agent tool parity", () => {
  it("classifies every Champion command the screen can send", () => {
    const unclassified = championMethods.filter(
      (method) =>
        !SCREEN_READS.has(method) && !(method in SCREEN_WRITES_TO_TOOLS) && !(method in EXCEPTIONS),
    );
    expect(unclassified).toEqual([]);
  });

  it("gives every screen write an agent tool", () => {
    const tools = new Set(Object.keys(ChampionsToolkit.tools));
    const missing = Object.entries({ ...SCREEN_WRITES_TO_TOOLS, ...EXCEPTIONS })
      .filter(([, tool]) => !tools.has(tool))
      .map(([method]) => method);
    expect(missing).toEqual([]);
  });

  it("gives every agent write tool a screen command or a listed reason", () => {
    const matched = new Set([
      ...Object.values(SCREEN_WRITES_TO_TOOLS),
      ...Object.values(EXCEPTIONS),
      ...RUN_ONLY_TOOLS,
      ...AGENT_ONLY_TOOLS,
    ]);
    expect(writeTools.filter((tool) => !matched.has(tool))).toEqual([]);
  });
});
