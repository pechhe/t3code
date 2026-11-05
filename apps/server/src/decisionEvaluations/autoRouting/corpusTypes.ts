export const PROJECTS = [
  "T3Peach",
  "YardSmith",
  "Weave",
  "PropSmith",
  "SlipJay",
  "Agents",
  "Homebase",
  "OddsAndEnds",
  "Splay",
  "NoProject",
] as const;
export type ProjectKey = (typeof PROJECTS)[number];

export const WORKFLOWS = ["chat", "solo", "shape", "lead"] as const;
export type Workflow = (typeof WORKFLOWS)[number];

/** Difficulty tiers for the main model of a thread and for a delegated worker. */
export const TIERS = ["routine", "demanding"] as const;
export type Tier = (typeof TIERS)[number];

export type Stratum = "authentic" | "synthetic";
export type Tag = "risky" | "ambiguous" | "explicit" | "chat";

/** The four decisions are asked and scored separately. */
export const DECISIONS = ["project", "workflow", "mainModel", "subagentTier"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface AutoCase {
  readonly id: string;
  readonly split: "tune" | "heldout";
  /** Cases of one family never straddle the tune/held-out split. */
  readonly family: string;
  readonly stratum: Stratum;
  readonly tags: ReadonlyArray<Tag>;
  /** The user's request, restated; the outcome of the real work is never in it. */
  readonly task: string;
  /** Where the user happened to start the thread: the current behaviour keeps it. May differ from the right project. */
  readonly startedIn: ProjectKey;
  /** Authentic cases: the repository the real change landed in. Synthetic: the author's design. Null when the task does not say. */
  readonly project: ProjectKey | null;
  /** What the user stated outright. The deterministic constraint rule must recover exactly this from the task text. */
  readonly explicit: {
    readonly project?: ProjectKey;
    readonly model?: "opus" | "sonnet";
    readonly workflow?: Workflow;
  };
  /** Authentic cases: the real landed change this restates (outcome evidence in `results/outcomes.json`). */
  readonly source?: {
    readonly repo: "t3code" | "slipjay" | "agent-config" | "yardsmith" | "odds-and-ends";
    readonly hash: string;
  };
}
