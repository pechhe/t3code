/**
 * Record measured provider usage only for Forge-linked threads; unknown usage has no queue row.
 * Resolve attribution on delivery because the turn can finish before its session reaches Weave.
 * Only T3 records usage; adapters supply orchestration facts.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { boundedRef } from "./boundedRef.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as WeaveForgeRecords from "./WeaveForgeRecords.ts";

/**
 * The tokens one request or one turn spent, as the provider billed them. `input` excludes cached
 * tokens: cache reads and writes stay separate so a reader can price them itself.
 */
export interface WeaveForgeUsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Absent when the provider reported no cache write; Weave is sent zero for it, as it takes no gap. */
  readonly cacheWrite?: number;
}

export interface WeaveForgeUsageInput {
  readonly threadId: ThreadId;
  /** Identifies the usage, so a replay or a repeated report stores one row. */
  readonly usageRef: string;
  /** Null when no usable tokens were measured: unknown usage records nothing. */
  readonly tokens: WeaveForgeUsageTokens | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds. */
  readonly endedAt: number;
  readonly modelRef: string;
  /**
   * The T3 run that spent the tokens. Never sent: it picks out the record of that run, whose session
   * Weave attributes the usage to.
   */
  readonly runId?: string;
  /** A single provider request, or the whole turn when its requests cannot be told apart. */
  readonly level: "request" | "turn";
}

const isoOf = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

/** Said once per process, so a missing provision is not silent and a test is not flooded. */
let droppedUsageWarned = false;

interface WeaveForgeUsageShape {
  readonly record: (input: WeaveForgeUsageInput) => Effect.Effect<void>;
}

export class WeaveForgeUsage extends Context.Reference<WeaveForgeUsageShape>(
  "t3/weave/WeaveForgeUsage",
  {
    // A process that never wired Weave's Forge records still runs the turns that report usage, and
    // has nothing to record it into. The provider registry builds the adapters, so it is given the
    // real recorder (`server.ts`); a layer that builds an adapter without it records nothing.
    defaultValue: () => ({
      record: (input) =>
        Effect.suspend(() => {
          if (input.tokens === null || droppedUsageWarned) return Effect.void;
          droppedUsageWarned = true;
          return Effect.logWarning(
            "A turn's usage was dropped: its adapter was built without the Forge usage recorder",
            { threadId: input.threadId },
          );
        }),
    }),
  },
) {}

/** The longest usage reference Weave accepts. */
const USAGE_REF_MAX_LENGTH = 500;

const make = Effect.gen(function* () {
  const specs = yield* ForgeSpecOfThread.ForgeSpecOfThread;
  const records = yield* WeaveForgeRecords.WeaveForgeRecords;
  const crypto = yield* Digest.Digest;

  const record: WeaveForgeUsageShape["record"] = Effect.fn("WeaveForgeUsage.record")(
    function* (input) {
      // Nothing measured is nothing to say; a zero would claim the request was free.
      if (input.tokens === null) return;
      const spec = yield* specs.of(input.threadId).pipe(
        Effect.map(Option.getOrNull),
        // Linked but unreadable now: the row is still owed, so it is queued without a Spec and the
        // delivery pass resolves one when it can. Its link's Weave needs no read to know.
        Effect.catchTags({
          BuildSpecUnavailable: (error) =>
            Effect.succeed({ specId: null, origin: error.origin } as const),
        }),
      );
      // Only a linked thread records anything; nothing was asked of Weave here.
      if (spec === null) return;
      yield* records.enqueue({
        kind: "usage",
        recordKey: `usage:${input.usageRef}`,
        threadId: input.threadId,
        specId: spec.specId,
        origin: spec.origin,
        t3RunId: input.runId,
        args: {
          usageRef: yield* boundedRef(crypto, input.usageRef, USAGE_REF_MAX_LENGTH),
          scope: "own",
          evidenceRef: `t3-thread://v1/${input.threadId}#${input.level}`,
          startedAt: isoOf(input.startedAt),
          endedAt: isoOf(input.endedAt),
          // Weave takes every token field, and a provider with no cache write has none to count.
          tokens: { ...input.tokens, cacheWrite: input.tokens.cacheWrite ?? 0 },
          activeMs: Math.max(0, Math.round(input.endedAt - input.startedAt)),
          harness: "t3code",
          modelRef: input.modelRef,
        },
      });
    },
    // A usage figure is not worth failing a turn over: the turn's own work comes first, and the
    // next report is a fresh chance to record it.
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record what a turn spent", cause),
        ),
      ),
  );

  return WeaveForgeUsage.of({ record });
});

export const layer = Layer.effect(WeaveForgeUsage, make);
