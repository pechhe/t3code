/**
 * Fork-owned: a `notifications/progress` beat per interval turns a tool call's response into an
 * event stream, so idle-timeout clients (Node 300 s, Bun about 356 s) keep waiting for long calls.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { McpSchema } from "effect/ai";

export const MCP_PROGRESS_HEARTBEAT_INTERVAL = Duration.seconds(30);

const progressTokenOf = (metadata: unknown): string | number | undefined => {
  if (!Predicate.isReadonlyObject(metadata)) return undefined;
  const token = (metadata as { readonly progressToken?: unknown }).progressToken;
  return typeof token === "string" || (typeof token === "number" && Number.isFinite(token))
    ? token
    : undefined;
};

/** The calling request's `_meta.progressToken`; sessions carry it on `McpServerClient`, sessionless requests on `McpRequestContext`. */
const currentProgressToken = Effect.gen(function* () {
  const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
  const context = yield* Effect.serviceOption(McpSchema.McpRequestContext);
  return (
    progressTokenOf(client._tag === "Some" ? client.value.requestMetadata : undefined) ??
    progressTokenOf(context._tag === "Some" ? context.value.requestMetadata : undefined)
  );
});

/** Runs `handle`, beating on the request's own response until it ends, fails or is interrupted. */
export const withProgressHeartbeat = Effect.fn("McpProgressHeartbeat.withProgressHeartbeat")(
  function* <A, E, R>(
    notifyProgress: (progress: {
      readonly progressToken: string | number;
      readonly progress: number;
      readonly message: string;
    }) => Effect.Effect<void>,
    handle: Effect.Effect<A, E, R>,
  ) {
    const progressToken = yield* currentProgressToken;
    if (progressToken === undefined) return yield* handle;
    let progress = 0;
    const beat = Effect.sleep(MCP_PROGRESS_HEARTBEAT_INTERVAL).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          progress += 1;
          return notifyProgress({ progressToken, progress, message: "Tool call still running" });
        }),
      ),
      Effect.forever,
    );
    // raceFirst interrupts the loser, so the heartbeat stops with the handler, however it ends.
    return yield* Effect.raceFirst(handle, beat);
  },
);
