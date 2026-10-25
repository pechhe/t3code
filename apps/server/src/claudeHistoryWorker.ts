import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type SelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- spawns the worker with a provider's environment.
import * as NodeChildProcess from "node:child_process";

// Bundled import.meta.main is always true; imports must have no side effects.
const HistoryOptions = Schema.Struct({
  dir: Schema.optionalKey(Schema.String),
  includeSystemMessages: Schema.optionalKey(Schema.Boolean),
  upToMessageId: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});
type HistoryOptions = typeof HistoryOptions.Type;
const decodeHistoryOptions = Schema.decodeSync(Schema.fromJsonString(HistoryOptions));

// The fork's head message is remapped by the SDK, so it is read back from the
// forked transcript for callers that roll the fork's first run back.
const forkWithHead = async (sessionId: string, options: Omit<HistoryOptions, "agentId">) => {
  const forked = await forkSession(sessionId, options);
  const headMessageId = await getSessionMessages(forked.sessionId, options)
    .then((messages) => messages.at(-1)?.uuid)
    .catch(() => undefined);
  return headMessageId === undefined ? forked : { ...forked, headMessageId };
};

const runHistory = (method: string | undefined, sessionId: string, options: HistoryOptions) => {
  const { agentId, ...rest } = options;
  if (method === "getSessionMessages") return getSessionMessages(sessionId, rest);
  if (method === "forkSession") return forkWithHead(sessionId, rest);
  if (method === "getSubagentMessages" && agentId !== undefined) {
    return getSubagentMessages(sessionId, agentId, rest);
  }
  throw new Error("Unknown Claude history operation.");
};

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result = await runHistory(method, sessionId, decodeHistoryOptions(rawOptions ?? "{}"));
  process.stdout.write(JSON.stringify(result));
}

/**
 * Runs a session helper against the Claude home in `environment`: in this
 * process when it is the server's own, otherwise through the `__claude-history`
 * subcommand of this T3 install.
 */
async function runClaudeHistory(
  method: "forkSession" | "getSubagentMessages",
  sessionId: string,
  options: HistoryOptions,
  environment: NodeJS.ProcessEnv,
  self: SelfInvocation,
): Promise<unknown> {
  // The SDK finds the Claude home from CLAUDE_CONFIG_DIR, else HOME.
  if (
    environment.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR &&
    environment.HOME === process.env.HOME
  ) {
    return runHistory(method, sessionId, options);
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      self.command,
      selfInvocationArgs(self, ["__claude-history", method, sessionId, JSON.stringify(options)]),
      // Desktop runs the server under Electron, which needs this to act as Node.
      { env: { ...environment, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
      (error, out, stderr) =>
        error === null ? resolve(out) : reject(new Error(stderr.trim() || error.message)),
    );
  });
  return JSON.parse(stdout);
}

export const readClaudeSubagentMessages = (
  sessionId: string,
  agentId: string,
  options: { readonly dir?: string; readonly limit?: number },
  environment: NodeJS.ProcessEnv,
  self: SelfInvocation,
) =>
  runClaudeHistory(
    "getSubagentMessages",
    sessionId,
    { ...options, agentId },
    environment,
    self,
  ) as Promise<ReadonlyArray<SessionMessage>>;
