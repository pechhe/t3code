// @effect-diagnostics nodeBuiltinImport:off - synchronous digest of the private cases
import * as NodeCrypto from "node:crypto";
import { actualProject, keywordProject } from "./baseline.ts";
import type { ProjectCase, ProjectPublic, Split, WakeCase, WakePublic } from "./types.ts";

const sha = (v: unknown) => NodeCrypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

export const publicProject = (c: ProjectCase, split: Split): ProjectPublic => ({
  caseId: c.caseId,
  machine: c.machine,
  split,
  stratum: c.stratum,
  asks: c.asks.length,
  keyword: keywordProject(c),
  agent: actualProject(c),
  digest: sha(c),
});
export const publicWake = (c: WakeCase, split: Split): WakePublic => ({
  caseId: c.caseId,
  machine: c.machine,
  split,
  wakeKind: c.wakeKind,
  source: c.source,
  outcome: c.outcome,
  digest: sha(c),
});

export const casesDigest = (
  cases: ReadonlyArray<{ readonly caseId: string; readonly digest: string }>,
) => sha(cases.map((c) => [c.caseId, c.digest]));

export const SAMPLING_RULE = [
  "Both machines are read-only snapshots of their live state database (this Mac and peach-box), taken on 10 Nov 2026.",
  'Project cases: top-level chats (no parent thread, not a delegated task) whose first message has at least 15 characters. Moved: the chat left "No project" and its recorded run count at the move is at least 1. Stayed: it is still in "No project" with no move. Asked at every turn it spent in "No project" up to five.',
  "Wake cases: a wake is a notification item, or a user message created by a scheduled task, that is the first item of its run (it started a turn). One that is not first steered a turn already running; one whose run holds only that item was dropped without a turn. Both are counted and left out.",
  "Wake kinds: delegated (delegated_task, subagent), command (background_command, monitor), watch (thread, build_item, landing), timed (scheduled-task message), system (unattended nudge and context notices). Other legacy background_task items are counted and left out.",
  'Ranking: every candidate is ranked by sha256("<machine>:<id>"), where the id is the thread id (project) or "<thread id>:<ordinal>" (wake). Per machine, the held-out set takes the first 35 moved and 55 stayed project chats (all 35 moved on the Mac, all 12 moved and 5 stayed on peach-box, because the pools are that small) and the first 20 wakes of each kind; the tuning set takes the next 6 stayed project chats and the next 5 wakes of each kind.',
];
