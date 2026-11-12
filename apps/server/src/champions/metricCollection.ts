import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const COLLECT_TIMEOUT = Duration.seconds(30);
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_EVIDENCE = 4000;
/** The server's provider keys and tokens stay out of a command an agent wrote. */
const INHERITED = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"];

export interface CollectedReading {
  readonly value: number | null;
  readonly revision: string | null;
  readonly evidence: string;
}

const Reading = Schema.Struct({
  value: Schema.Finite,
  revision: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.String),
});
const decodeReading = Schema.decodeUnknownOption(Schema.fromJsonString(Reading));
const clip = (text: string) =>
  text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}…` : text;

/** A number alone, or `{"value": n, "revision"?: string, "evidence"?: string}`. */
export function parseReading(stdout: string): CollectedReading | null {
  const text = stdout.trim();
  if (text === "") return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? { value, revision: null, evidence: text } : null;
  }
  const decoded = decodeReading(text);
  if (decoded._tag === "None") return null;
  return {
    value: decoded.value.value,
    revision: decoded.value.revision ?? null,
    evidence: clip(decoded.value.evidence ?? text),
  };
}

const failed = (reason: string): CollectedReading => ({
  value: null,
  revision: null,
  evidence: clip(reason),
});

export const collectReading = Effect.fn("ChampionService.collectReading")(function* (
  processes: ProcessRunner.ProcessRunner["Service"],
  command: ReadonlyArray<string>,
  cwd: string | undefined,
) {
  const host = yield* HostProcess.Environment;
  const [executable, ...args] = command;
  if (executable === undefined) return failed("Collection failed: the metric names no command.");
  const env = Object.fromEntries(
    INHERITED.flatMap((name) => (host[name] === undefined ? [] : [[name, host[name]]])),
  );
  return yield* processes
    .run({
      command: executable,
      args,
      cwd,
      env,
      inheritEnv: false,
      timeout: COLLECT_TIMEOUT,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((result) => {
        if (result.code !== 0)
          return failed(
            `Collection failed: the command exited with ${result.code ?? "no exit code"}. ${result.stderr.trim() || result.stdout.trim()}`,
          );
        return (
          parseReading(result.stdout) ??
          failed(
            `Collection failed: the command printed neither a number nor a JSON reading. ${result.stdout.trim()}`,
          )
        );
      }),
      Effect.catchTags({
        ProcessTimeoutError: () =>
          Effect.succeed(
            failed(
              `Collection failed: the command did not finish within ${Duration.toSeconds(COLLECT_TIMEOUT)} seconds.`,
            ),
          ),
      }),
      Effect.catch((error) => Effect.succeed(failed(`Collection failed: ${error.message}`))),
    );
});
