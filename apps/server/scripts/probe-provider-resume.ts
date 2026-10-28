// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off preferSchemaOverJson:off - Manual host-side probe that drives the CLI and a child server.
// Probes whether T3 can resume a settled thread after its native provider transcript is removed.
//
//   node apps/server/scripts/probe-provider-resume.ts [--claude-model <slug>] [--codex-model <slug>] [--port <n>] [--keep]
//
// Runs entirely in a scratch HOME and T3 base dir. The only live files it touches are read-only copies of
// the Claude Code and Codex credentials, and those copies are deleted on exit unless --keep is passed.
// Spends a few short turns on your Claude and Codex subscriptions.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    "claude-model": { type: "string", default: "claude-haiku-5-5" },
    "codex-model": { type: "string", default: "gpt-6.1-sol" },
    port: { type: "string", default: "4871" },
    keep: { type: "boolean", default: false },
  },
});
const port = values.port;
const serverEntry = NodePath.resolve(import.meta.dirname, "../src/bin.ts");
const liveHome = NodeOS.homedir();
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-resume-"));
const home = NodePath.join(scratch, "home");
const baseDir = NodePath.join(scratch, "t3");
const project = NodePath.join(scratch, "project");

const cleanEnv = {
  HOME: home,
  PATH: process.env.PATH ?? "",
  TERM: "dumb",
};
const t3 = (...args: Array<string>) =>
  NodeChildProcess.spawnSync(process.execPath, [serverEntry, ...args], {
    env: cleanEnv,
    encoding: "utf8",
  });

const copyCredential = (relative: string) => {
  const target = NodePath.join(home, relative);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.copyFileSync(NodePath.join(liveHome, relative), target);
  NodeFS.chmodSync(target, 0o600);
};

let server: NodeChildProcess.ChildProcess | undefined;
const startServer = async () => {
  server = NodeChildProcess.spawn(
    process.execPath,
    [
      serverEntry,
      "serve",
      "--base-dir",
      baseDir,
      "--port",
      port,
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    { env: cleanEnv, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port: Number(port) });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The probe server did not start.");
};
const stopServer = async () => {
  const child = server;
  server = undefined;
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
};

const startThread = (provider: string, model: string, title: string, word: string) => {
  const result = t3(
    "thread",
    "start",
    "--base-dir",
    baseDir,
    "--provider",
    provider,
    "--model",
    model,
    "--title",
    title,
    "--wait",
    "--json",
    project,
    `Reply with exactly: the secret word is ${word}. Do not use tools.`,
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as { threadId: string; status: string; error: string | null };
  if (parsed.status !== "completed") {
    throw new Error(`${title}: first turn ${parsed.status}: ${parsed.error ?? "no error"}`);
  }
  return parsed.threadId;
};

const nativeIds = () => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    const ids = new Map<string, string>();
    const rows = db
      .prepare("select thread_id, payload_json from orchestration_v2_projection_provider_threads")
      .all() as Array<{ thread_id: string; payload_json: string }>;
    for (const row of rows) {
      const nativeId = JSON.parse(row.payload_json).nativeThreadRef?.nativeId;
      if (typeof nativeId === "string") ids.set(row.thread_id, nativeId);
    }
    return ids;
  } finally {
    db.close();
  }
};

const findFile = (root: string, suffix: string): string | undefined => {
  if (!NodeFS.existsSync(root)) return undefined;
  for (const entry of NodeFS.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      return NodePath.join(entry.parentPath, entry.name);
    }
  }
  return undefined;
};

interface Subject {
  readonly label: string;
  readonly threadId: string;
  readonly transcript: () => string | undefined;
}

const followUp = (threadId: string) => {
  const sent = t3(
    "thread",
    "send",
    "--base-dir",
    baseDir,
    "--wait",
    "--json",
    threadId,
    "Without using tools: what secret word did I ask you to reply with in my first message? If you cannot tell, say so.",
  );
  const parsed = JSON.parse(sent.stdout.trim().split("\n").at(-1) ?? "{}") as {
    status?: string;
    reply?: string | null;
    error?: string | null;
  };
  const shown = t3("thread", "show", "--base-dir", baseDir, "--json", threadId);
  const messages = JSON.parse(shown.stdout.slice(shown.stdout.indexOf("{")))
    .messages as Array<unknown>;
  return { outcome: parsed, visibleMessages: messages.length };
};

const main = async () => {
  NodeFS.mkdirSync(NodePath.join(home, ".codex"), { recursive: true });
  copyCredential(".claude/.credentials.json");
  copyCredential(".claude.json");
  copyCredential(".codex/auth.json");
  NodeFS.writeFileSync(NodePath.join(home, ".claude", "settings.json"), "{}");
  NodeFS.writeFileSync(
    NodePath.join(home, ".codex", "config.toml"),
    `model = "${values["codex-model"]}"\nmodel_reasoning_effort = "low"\n`,
  );
  NodeFS.mkdirSync(project, { recursive: true });
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=probe",
      "-c",
      "user.email=probe@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
  ]) {
    NodeChildProcess.execFileSync("git", args, { cwd: project });
  }

  await startServer();
  t3("project", "add", "--base-dir", baseDir, project);
  const claude = values["claude-model"];
  const codex = values["codex-model"];
  const threads = {
    claudeRemoved: startThread("claudeAgent", claude, "claude-removed", "PINEAPPLE-7"),
    claudeControl: startThread("claudeAgent", claude, "claude-control", "MANGO-3"),
    codexRemoved: startThread("codex", codex, "codex-removed", "KUMQUAT-5"),
    codexControl: startThread("codex", codex, "codex-control", "PAPAYA-9"),
  };
  const ids = nativeIds();
  const native = (threadId: string) => ids.get(threadId) as string;
  await stopServer();

  const subjects: Array<Subject & { readonly removeTranscript: boolean }> = [
    {
      label: "claude control",
      threadId: threads.claudeControl,
      transcript: () =>
        findFile(
          NodePath.join(home, ".claude", "projects"),
          `${native(threads.claudeControl)}.jsonl`,
        ),
      removeTranscript: false,
    },
    {
      label: "claude transcript removed",
      threadId: threads.claudeRemoved,
      transcript: () =>
        findFile(
          NodePath.join(home, ".claude", "projects"),
          `${native(threads.claudeRemoved)}.jsonl`,
        ),
      removeTranscript: true,
    },
    {
      label: "codex control",
      threadId: threads.codexControl,
      transcript: () =>
        findFile(
          NodePath.join(home, ".codex", "sessions"),
          `${native(threads.codexControl)}.jsonl`,
        ),
      removeTranscript: false,
    },
    {
      label: "codex transcript removed",
      threadId: threads.codexRemoved,
      transcript: () =>
        findFile(
          NodePath.join(home, ".codex", "sessions"),
          `${native(threads.codexRemoved)}.jsonl`,
        ),
      removeTranscript: true,
    },
  ];

  for (const subject of subjects.filter((entry) => entry.removeTranscript)) {
    const file = subject.transcript();
    if (file === undefined)
      throw new Error(`${subject.label}: no native transcript found to remove.`);
    NodeFS.rmSync(file);
  }
  await startServer();
  console.log("run                       visible  turn status  reply or error");
  for (const subject of subjects) {
    const { outcome, visibleMessages } = followUp(subject.threadId);
    const detail = (outcome.reply ?? outcome.error ?? "").replace(/\s+/g, " ").slice(0, 100);
    console.log(
      `${subject.label.padEnd(25)} ${String(visibleMessages).padEnd(8)} ${(outcome.status ?? "?").padEnd(12)} ${detail}`,
    );
  }
};

main()
  .catch((cause) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    if (values.keep) {
      console.log(`Scratch kept at ${scratch} (contains copied credentials).`);
    } else {
      NodeFS.rmSync(scratch, { recursive: true, force: true });
    }
  });
