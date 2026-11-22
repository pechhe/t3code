// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Signs a Pi account in through Pi's own `ModelRuntime.login`, extensions loaded, in a child
 * process whose prompts and links cross stdio as JSON lines, so a browser on another machine
 * can finish a localhost-redirect sign-in by pasting the callback URL.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as NodePath from "node:path";

import { decodeJsonOption } from "./compaction.ts";

export const PI_LOGIN_SDK_ENV = "T3_PI_LOGIN_SDK";
export const PI_LOGIN_PROVIDER_ENV = "T3_PI_LOGIN_PROVIDER";

/** No T3 imports: it runs under plain Node and loads Pi from the user's install. */
export const PI_ACCOUNT_LOGIN_SCRIPT = String.raw`
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const safe = (error) => String(error && error.message ? error.message : error).slice(0, 500);
const controller = new AbortController();
const pending = new Map();
let sequence = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "cancel") controller.abort();
  if (message.type === "answer" && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    waiter.resolve(String(message.value ?? ""));
  }
}).on("close", () => {
  // T3 went away (a restart): nobody can finish this sign-in, so stop listening for it.
  controller.abort();
  setTimeout(() => process.exit(0), 5000).unref();
});

let session;
try {
  const sdk = await import(pathToFileURL(process.env.T3_PI_LOGIN_SDK).href);
  const providerId = process.env.T3_PI_LOGIN_PROVIDER;
  ({ session } = await sdk.createAgentSession({ sessionManager: sdk.SessionManager.inMemory(), cwd: process.cwd() }));
  const runtime = session.modelRuntime;
  const provider = runtime.getProviders().find((candidate) => candidate.id === providerId);
  if (!provider || !provider.auth || !provider.auth.oauth) {
    emit({ type: "error", message: "Pi has no sign-in for " + providerId + ". Check that the extension for this account is installed." });
  } else {
    const settings = sdk.SettingsManager.create(process.cwd(), sdk.getAgentDir(), { projectTrusted: false });
    await runtime.login(providerId, "oauth", {
      signal: controller.signal,
      prompt(prompt) {
        const id = "p" + ++sequence;
        emit({
          type: "prompt",
          id,
          kind: prompt.type,
          message: String(prompt.message ?? ""),
          placeholder: prompt.placeholder ?? null,
          options: (prompt.options ?? []).map((option) => ({ id: String(option.id), label: String(option.label) })),
        });
        return new Promise((resolve, reject) => {
          const close = () => {
            if (!pending.delete(id)) return;
            emit({ type: "prompt_closed", id });
            reject(new Error("Login cancelled"));
          };
          pending.set(id, { resolve });
          controller.signal.addEventListener("abort", close, { once: true });
          prompt.signal?.addEventListener("abort", close, { once: true });
        });
      },
      notify(event) {
        if (event.type === "auth_url") emit({ type: "auth_url", url: event.url, instructions: event.instructions ?? null });
        else if (event.type === "device_code") emit({ type: "device_code", url: event.verificationUri, userCode: event.userCode });
        else emit({ type: "progress", message: String(event.message ?? "") });
      },
    }, { getDeviceId: () => settings.getOrCreateDeviceId() });
    emit({ type: "done" });
  }
} catch (error) {
  emit(controller.signal.aborted ? { type: "cancelled" } : { type: "error", message: safe(error) });
} finally {
  session?.dispose();
  process.exit(0);
}
`;

export type PiLoginEvent =
  | { readonly type: "auth_url"; readonly url: string; readonly instructions: string | null }
  | { readonly type: "device_code"; readonly url: string; readonly userCode: string }
  | {
      readonly type: "prompt";
      readonly id: string;
      readonly kind: "text" | "secret" | "manual_code" | "select";
      readonly message: string;
      readonly placeholder: string | null;
      readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    }
  | { readonly type: "prompt_closed"; readonly id: string }
  | { readonly type: "progress"; readonly message: string }
  | { readonly type: "done" }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly message: string };

const KINDS = new Set(["text", "secret", "manual_code", "select"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** One line the login script wrote, or undefined for anything else on its stdout. */
export function parsePiLoginEvent(line: string): PiLoginEvent | undefined {
  const parsed = decodeJsonOption(line);
  if (Option.isNone(parsed) || !isRecord(parsed.value)) return undefined;
  const event = parsed.value;
  switch (event["type"]) {
    case "auth_url":
      return /^https?:\/\//i.test(text(event["url"]))
        ? {
            type: "auth_url",
            url: text(event["url"]),
            instructions: text(event["instructions"]) || null,
          }
        : undefined;
    case "device_code":
      return /^https?:\/\//i.test(text(event["url"])) && text(event["userCode"])
        ? { type: "device_code", url: text(event["url"]), userCode: text(event["userCode"]) }
        : undefined;
    case "prompt": {
      const kind = text(event["kind"]);
      if (!KINDS.has(kind) || !text(event["id"])) return undefined;
      return {
        type: "prompt",
        id: text(event["id"]),
        kind: kind as "text",
        message: text(event["message"]),
        placeholder: text(event["placeholder"]) || null,
        options: Array.isArray(event["options"])
          ? event["options"]
              .filter(isRecord)
              .map((option) => ({ id: text(option["id"]), label: text(option["label"]) }))
          : [],
      };
    }
    case "prompt_closed":
      return text(event["id"]) ? { type: "prompt_closed", id: text(event["id"]) } : undefined;
    case "progress":
      return { type: "progress", message: text(event["message"]) };
    case "done":
    case "cancelled":
      return { type: event["type"] };
    case "error":
      return { type: "error", message: text(event["message"]) || "Sign-in failed." };
    default:
      return undefined;
  }
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * The SDK entry of the Pi install a binary path runs: the binary is a script inside the
 * package (often behind a symlink), so walk up from its real path to the package root. A
 * compiled build (Pi-Bolt) has no SDK; then `pi` on PATH signs in, into the same agent dir.
 */
export const resolvePiSdkEntry = Effect.fn("PiAccountLogin.resolveSdkEntry")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const onPath = (name: string) =>
    (environment["PATH"] ?? "")
      .split(NodePath.delimiter)
      .filter(Boolean)
      .map((directory) => NodePath.join(directory, name));
  const candidates = [
    ...(NodePath.isAbsolute(binaryPath) ? [binaryPath] : onPath(binaryPath)),
    ...onPath("pi"),
  ];
  for (const candidate of candidates) {
    const real = yield* fileSystem.realPath(candidate).pipe(Effect.option);
    if (Option.isNone(real)) continue;
    let directory = NodePath.dirname(real.value);
    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = yield* fileSystem
        .readFileString(NodePath.join(directory, "package.json"))
        .pipe(Effect.option);
      const parsed = Option.isSome(manifest) ? decodeJsonOption(manifest.value) : Option.none();
      if (Option.isSome(parsed) && isRecord(parsed.value) && parsed.value["name"] === PI_PACKAGE) {
        const entry = NodePath.join(directory, "dist", "index.js");
        if (yield* fileSystem.exists(entry).pipe(Effect.orElseSucceed(() => false))) return entry;
      }
      const parent = NodePath.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
});
