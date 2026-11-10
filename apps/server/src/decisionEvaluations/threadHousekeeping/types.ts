import type { DecisionRequest } from "@t3tools/contracts";

export type Engine = DecisionRequest["engine"];
export const ENGINES = ["jev", "luna"] as const satisfies ReadonlyArray<Engine>;

export interface EvidenceLine {
  readonly role: "user" | "assistant";
  readonly n: number;
  readonly text: string;
}

export interface ProjectOption {
  readonly key: string;
  readonly choice: string;
  readonly title: string;
  readonly root: string;
  readonly recent: ReadonlyArray<string>;
}

/** One chat that sat in "No project". Private: real thread text, built locally from the snapshot and never committed. */
export interface ProjectCase {
  readonly caseId: string;
  readonly machine: string;
  readonly kind: "project";
  readonly stratum: "moved" | "stayed";
  readonly actualProjectId: string | null;
  readonly firstText: string;
  /** One entry per turn the chat spent in "No project", capped; the last is the decision point. */
  readonly asks: ReadonlyArray<{
    readonly turn: number;
    readonly evidence: ReadonlyArray<EvidenceLine>;
  }>;
  readonly projects: ReadonlyArray<ProjectOption>;
}

export const WAKE_KINDS = ["delegated", "command", "watch", "timed", "system"] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

/** One wake that started a turn. Private, like `ProjectCase`. */
export interface WakeCase {
  readonly caseId: string;
  readonly machine: string;
  readonly kind: "wake";
  readonly wakeKind: WakeKind;
  readonly source: string | null;
  readonly outcome: string | null;
  readonly threadTitle: string | null;
  readonly prior: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
  readonly wake: { readonly summary: string; readonly detail: string };
}

export type Split = "heldout" | "tune";

export interface PrivateCases {
  readonly audit: Record<string, unknown>;
  readonly projectHeldout: ReadonlyArray<ProjectCase>;
  readonly projectTune: ReadonlyArray<ProjectCase>;
  readonly wakeHeldout: ReadonlyArray<WakeCase>;
  readonly wakeTune: ReadonlyArray<WakeCase>;
}

export type Chore = "project" | "wake";

/** What a committed record keeps of a case: no thread text, only what scoring needs. */
export interface ProjectPublic {
  readonly caseId: string;
  readonly machine: string;
  readonly split: Split;
  readonly stratum: "moved" | "stayed";
  readonly asks: number;
  /** The frozen keyword rule's route and the agent's actual one, as listed choice ids, `none` or `unlisted`. */
  readonly keyword: string;
  readonly agent: string;
  readonly digest: string;
}
export interface WakePublic {
  readonly caseId: string;
  readonly machine: string;
  readonly split: Split;
  readonly wakeKind: WakeKind;
  readonly source: string | null;
  readonly outcome: string | null;
  readonly digest: string;
}
