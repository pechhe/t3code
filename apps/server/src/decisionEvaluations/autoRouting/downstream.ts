// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - scores the retained downstream answers
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Bounded downstream comparison of the two supported managed worker tiers on read-only investigation tasks about this repository.
 * Tasks and their behaviour checks were fixed before any worker ran; each check is a deterministic pattern over the answer.
 * Routine tier: the `chore-worker` role. Demanding tier: the `implementation-worker` role. Both ran read-only, the same prompt,
 * the same workspace, once. The pairs differ in role brief and model as well as tier; this is the tier the policy actually offers.
 */
export interface DownstreamTask {
  readonly id: string;
  readonly kind: "plain" | "deceptively-simple";
  readonly prompt: string;
  readonly checks: ReadonlyArray<{ readonly id: string; readonly pattern: RegExp }>;
}

const FOOTER =
  "\n\nThis is a read-only investigation: do not modify any file. Answer from the repository in your workspace. Cite file paths. Be concise.";

export const TASKS: ReadonlyArray<DownstreamTask> = [
  {
    id: "p-failure-codes",
    kind: "plain",
    prompt:
      "List every value of the decision failure code type in packages/contracts and the file that defines it." +
      FOOTER,
    checks: [
      "invalid-input",
      "unavailable",
      "invalid-provider-response",
      "transport-error",
      "cancelled",
      "timeout",
      "busy",
      "rate-limited",
    ].map((c) => ({ id: c, pattern: new RegExp(`\\b${c}\\b`) })),
  },
  {
    id: "p-limits",
    kind: "plain",
    prompt:
      "What are the numeric admission limits of the shared DecisionService (input size, questions per request, concurrent calls, calls per minute, deadline) and where are they defined?" +
      FOOTER,
    checks: [
      { id: "file", pattern: /packages\/contracts\/src\/decisions\.ts/ },
      { id: "input", pattern: /128 ?KiB|128 ?KB|131,?072/i },
      { id: "questions", pattern: /\b32\b/ },
      {
        id: "concurrent",
        pattern: /concurren\w*[^.\n]{0,40}\b(4|four)\b|\b(4|four)\b[^.\n]{0,40}(concurren|active)/i,
      },
      { id: "perMinute", pattern: /\b60\b/ },
      { id: "deadline", pattern: /20[ ,_]?000 ?ms|\b20[- ]?(s|sec)/i },
    ],
  },
  {
    id: "p-landing-verification",
    kind: "plain",
    prompt:
      "Which commands does slipjay.json require before a landing (requiredLandingVerification)? List each with its working directory." +
      FOOTER,
    checks: [
      { id: "playwright", pattern: /playwright[^\n]{0,60}chromium-headless-shell/i },
      { id: "test-landing", pattern: /scripts\/test-landing\.ts/ },
      { id: "typecheck-server", pattern: /--filter t3\b[^\n]{0,20}typecheck/ },
      { id: "typecheck-web", pattern: /@t3tools\/web[^\n]{0,20}typecheck/ },
      { id: "receipt", pattern: /fork-upstream-receipt/ },
    ],
  },
  {
    id: "r-codex-full-access",
    kind: "deceptively-simple",
    prompt:
      "A user says Codex still shows an approval card for one kind of request even in full access. In apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts, how many separate places auto-accept a Codex request because the runtime mode is full-access (ignore the mode-to-sandbox mapping), and which request kinds do they cover?" +
      FOOTER,
    checks: [
      {
        id: "six",
        pattern:
          /\b(6|six)\b[^\n]{0,60}(places|sites|branches|handlers|occurrences|spots|locations)|(places|sites|branches|handlers|occurrences)[^\n]{0,30}\b(6|six)\b/i,
      },
      { id: "command", pattern: /command[ -]?execution/i },
      { id: "filechange", pattern: /file[ -]?change/i },
    ],
  },
  {
    id: "r-rate-limit-change",
    kind: "deceptively-simple",
    prompt:
      "Someone proposes raising the DecisionService calls-per-minute limit from 60 to 120 for faster experiments. Which files hold or state that number or enforce it, and what else would a careful change need to account for?" +
      FOOTER,
    checks: [
      { id: "contract", pattern: /packages\/contracts\/src\/decisions\.ts/ },
      { id: "service", pattern: /DecisionService\.ts/ },
      { id: "doc", pattern: /docs\/operations\/decisions\.md/ },
      { id: "in-memory", pattern: /in[- ]memory|per (server )?environment|restart|not persisted/i },
      { id: "pacing", pattern: /README|gap-ms|pac(e|ing)|evaluation/i },
    ],
  },
  {
    id: "r-readonly-providers",
    kind: "deceptively-simple",
    prompt:
      'Which providers declare readOnlySourceAccess "enforced" anywhere in this repository (not only under apps/server/src/provider), and where is that field\'s type defined?' +
      FOOTER,
    checks: [
      ...["antigravity", "claude", "codex", "grok", "muse", "opencode", "pi"].map((p) => ({
        id: p,
        pattern: new RegExp(`provider-${p}|${p}Provider|\\b${p}\\b`, "i"),
      })),
      { id: "contract", pattern: /packages\/contracts\/src\/server\.ts/ },
      { id: "pools", pattern: /providerPools\.ts/ },
    ],
  },
];

export const scoreAnswer = (task: DownstreamTask, answer: string) => {
  const passed = task.checks.filter((c) => c.pattern.test(answer)).map((c) => c.id);
  return {
    passed,
    failed: task.checks.map((c) => c.id).filter((id) => !passed.includes(id)),
    total: task.checks.length,
  };
};

if (import.meta.main) {
  const file = NodePath.join(import.meta.dirname, "results/downstream.json");
  const retained = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    runs: ReadonlyArray<{ taskId: string; tier: string; answer: string | null }>;
  };
  const out = retained.runs.map((r) => {
    const task = TASKS.find((t) => t.id === r.taskId)!;
    return {
      taskId: r.taskId,
      tier: r.tier,
      ...(r.answer === null
        ? { passed: [], failed: task.checks.map((c) => c.id), total: task.checks.length }
        : scoreAnswer(task, r.answer)),
    };
  });
  console.log(JSON.stringify(out, null, 2));
}
