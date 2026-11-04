// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline corpus builder, run by hand
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { PoolItem } from "./corpusTypes.ts";
import { FINDINGS } from "./findings.ts";

/**
 * Builds `pool.json`: the candidate items a ranker may be shown. Everything is extracted mechanically from real sources
 * (skill front matter, markdown headings, exported names) so no description was written to flatter either engine.
 * Prior findings are not extracted here; they are authored in `findings.ts`.
 */
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(here, "../../../../..");

/** Source files touched by the real commits that the authentic cases are drawn from, plus neighbours that make plausible distractors. */
const SOURCE_FILES = [
  "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
  "apps/server/src/auth/McpOAuth.ts",
  "apps/server/src/auth/dpop.ts",
  "apps/server/src/auth/forwardedUrl.ts",
  "apps/server/src/mcp/OrchestratorMcpService.ts",
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "apps/server/src/orchestration-v2/ThreadManagementService.ts",
  "apps/server/src/orchestration-v2/ThreadWatchReactor.ts",
  "apps/server/src/orchestration-v2/threadWatch.ts",
  "packages/provider-core/src/server/subagentProjection.ts",
  "packages/shared/src/orchestrationV2PendingBackgroundWork.ts",
  "apps/server/src/orchestration-v2/ProjectionStore.ts",
  "apps/server/src/agents/ManagedAgentService.ts",
  "apps/server/src/orchestration-v2/ProviderSessionManager.ts",
  "apps/server/src/hq/HqSignInRoute.ts",
  "apps/server/src/orchestration-v2/ProviderTurnControlService.ts",
  "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
  "apps/server/src/videoFrames/VideoFrames.ts",
  "scripts/fork-nightly.sh",
  "apps/server/src/orchestration-v2/ProjectionMaintenance.ts",
  "apps/server/src/orchestration-v2/compactionCandidates.ts",
  "apps/server/src/persistence/Migrations.ts",
  "apps/server/src/agents/AgentRoleResolver.ts",
  "apps/server/src/provider/ClaudeProvider.ts",
  "apps/server/src/provider/CodexProvider.ts",
  "apps/web/src/components/settings/DelegationSettings.logic.ts",
  "apps/web/src/components/settings/DelegationSettings.tsx",
  "apps/server/src/hq/ForgeWorkItems.ts",
  "apps/server/src/orchestration-v2/ForgeWatchReactor.ts",
  "apps/server/src/orchestration-v2/LandingWatchReactor.ts",
  "apps/server/src/mcp/toolkits/orchestrator/tools.ts",
  "packages/provider-core/src/server/orchestrationInstructions.ts",
  "apps/server/src/orchestration-v2/RuntimePolicy.ts",
  "packages/contracts/src/agentPolicy.ts",
  "packages/contracts/src/server.ts",
  "packages/provider-core/src/server/snapshotProbe.ts",
  "packages/provider-pi/src/server/status.ts",
  "apps/server/src/mcp/McpHttpServer.ts",
  "apps/server/src/mcp/McpInvocationContext.ts",
  "apps/server/src/mcp/McpSessionRegistry.ts",
  "apps/server/src/mcp/WebResearch.ts",
  "apps/server/src/mcp/toolkits/web/handlers.ts",
  "apps/server/src/hq/HqAgentConnections.ts",
  "apps/server/src/orchestration-v2/CheckpointRollbackService.ts",
  "apps/server/src/hq/ForgeHome.ts",
  "packages/contracts/src/forgeHome.ts",
  "apps/server/src/hq/HqForgeRecordingReactor.ts",
  "apps/server/src/hq/HqForgeRecords.ts",
  "apps/server/src/project/WorkspaceProvider.ts",
  "apps/server/scripts/probe-provider-resume.ts",
  "apps/server/src/decisions/DecisionService.ts",
  "apps/server/src/decisions/adapters.ts",
  "packages/contracts/src/decisions.ts",
  "AGENTS.md",
  "fork/README.md",
  "fork/differences.md",
  "knip.jsonc",
  "docs/dependencies.md",
  "apps/server/src/decisionEvaluations/failureTriage/README.md",
  "apps/server/src/decisionEvaluations/semanticLint/README.md",
  "apps/server/src/decisionEvaluations/semanticLint/scoring.ts",
  "apps/server/src/decisionEvaluations/failureTriage/provenance.ts",
  "apps/server/src/decisionEvaluations/failureTriage/run.ts",
];
const DOC_DIRS = ["docs/internals", "docs/operations", "docs/user"];
const SKILL_DIRS = [
  NodePath.join(NodeOS.homedir(), ".agents/skills"),
  NodePath.join(repoRoot, ".agents/skills"),
];

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const markdownDescription = (text: string): string => {
  const lines = text.split("\n");
  const title =
    lines
      .find((l) => l.startsWith("# "))
      ?.slice(2)
      .trim() ?? "";
  const body: string[] = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      if (started) break;
      continue;
    }
    if (line.trim() === "") {
      if (started) break;
      continue;
    }
    started = true;
    body.push(line);
  }
  return clip(`${title}. ${oneLine(body.join(" "))}`, 320);
};

const sourceDescription = (path: string, text: string): string => {
  const names = [
    ...text.matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/gm,
    ),
  ].map((m) => m[1]!);
  return clip(names.length > 0 ? `${path} exports ${names.slice(0, 6).join(", ")}` : path, 240);
};

const items: PoolItem[] = [];
for (const dir of SKILL_DIRS) {
  if (!NodeFS.existsSync(dir)) continue;
  for (const name of NodeFS.readdirSync(dir).sort()) {
    const file = NodePath.join(dir, name, "SKILL.md");
    if (!NodeFS.existsSync(file)) continue;
    const text = NodeFS.readFileSync(file, "utf8");
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (description === undefined || items.some((i) => i.id === `skill:${name}`)) continue;
    items.push({
      id: `skill:${name}`,
      kind: "skill",
      title: name,
      description: clip(description, 400),
      bodyBytes: Buffer.byteLength(text),
    });
  }
}
for (const dir of DOC_DIRS) {
  for (const f of NodeFS.readdirSync(NodePath.join(repoRoot, dir)).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = `${dir}/${f}`;
    const text = NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8");
    items.push({
      id: `file:${path}`,
      kind: "file",
      title: path,
      description: markdownDescription(text),
      bodyBytes: Buffer.byteLength(text),
    });
  }
}
for (const path of SOURCE_FILES) {
  const abs = NodePath.join(repoRoot, path);
  if (!NodeFS.existsSync(abs)) continue;
  const text = NodeFS.readFileSync(abs, "utf8");
  items.push({
    id: `file:${path}`,
    kind: "file",
    title: path,
    description: path.endsWith(".md") ? markdownDescription(text) : sourceDescription(path, text),
    bodyBytes: Buffer.byteLength(text),
  });
}
for (const f of FINDINGS)
  items.push({
    id: `finding:${f.slug}`,
    kind: "finding",
    title: f.title,
    description: f.text,
    bodyBytes: Buffer.byteLength(`${f.title}\n${f.text}`),
  });
const head = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const out = NodePath.join(here, "pool.json");
NodeFS.writeFileSync(out, `${JSON.stringify({ builtFrom: head, items }, null, 2)}\n`);
console.log(
  `${items.length} items (${items.filter((i) => i.kind === "skill").length} skills) -> ${out}`,
);
