import {
  type ForgeArcRunDetailInput,
  type ForgeArcRunDetailResult,
  type ForgeArcRunReadInput,
  type ForgeArcRunSummaryResult,
  type ForgeArcRunArc,
  type ForgeArcRunSpecThread,
  ForgeWorkItemError,
} from "@t3tools/contracts";
import { forgeItemUrl } from "@t3tools/shared/forgeLinks";
import { sameWeaveAddress } from "@t3tools/shared/weaveOrigins";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { arcRunScopesOverlap } from "../orchestration-v2/arcRun.ts";
import * as ForgeWorkItems from "./ForgeWorkItems.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

const Arc = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Backlinks = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      node: Schema.Struct({
        available: Schema.Boolean,
        object: Schema.optionalKey(Schema.String),
        number: Schema.optionalKey(Schema.Number),
        node: Schema.optionalKey(Schema.Struct({ id: Schema.String, kind: Schema.String })),
      }),
    }),
  ),
  cursor: Schema.NullOr(Schema.String),
});
const decodeArc = Schema.decodeUnknownOption(Arc);
const decodeBacklinks = Schema.decodeUnknownOption(Backlinks);
const unavailable = () =>
  new ForgeWorkItemError({
    reason: "unavailable",
    message: "Weave could not be reached. Try again shortly.",
  });

export class ForgeArcRuns extends Context.Service<
  ForgeArcRuns,
  {
    readonly summary: (
      input: ForgeArcRunReadInput,
    ) => Effect.Effect<ForgeArcRunSummaryResult, ForgeWorkItemError>;
    readonly detail: (
      input: ForgeArcRunDetailInput,
    ) => Effect.Effect<ForgeArcRunDetailResult, ForgeWorkItemError>;
  }
>()("t3/weave/ForgeArcRuns") {}

interface Membership extends ForgeWorkItems.ReadCadence {
  readonly arc: ForgeArcRunArc;
  readonly goal: string | null;
  readonly numbers: ReadonlyArray<number>;
  readonly complete: boolean;
  readonly attemptedAt: number;
  readonly read: boolean;
}
interface DetailCache extends ForgeWorkItems.ReadCadence {
  readonly value: NonNullable<ForgeArcRunDetailResult>;
  readonly attemptedAt: number;
  readonly opens: ReadonlyArray<string>;
}
const remember = <T>(cache: Map<string, T>, key: string, value: T) => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 256) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
};

const make = Effect.gen(function* () {
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  const workItems = yield* ForgeWorkItems.ForgeWorkItems;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const membership = new Map<string, Membership>();
  const details = new Map<string, DetailCache>();
  const lock = yield* KeyedLock.make<string>();
  const context = Effect.fn("ForgeArcRuns.context")(function* (input: ForgeArcRunReadInput) {
    const shell = yield* threads.getThreadShell(input.threadId);
    if (shell === null || shell.deletedAt !== null || shell.arcRun?.arc.number !== input.arc)
      return null;
    const connection = yield* weave.read;
    return connection === null ? null : { shell, run: shell.arcRun, connection };
  }, Effect.mapError(unavailable));
  type RunContext = NonNullable<Effect.Success<ReturnType<typeof context>>>;
  const readMembership = Effect.fn("ForgeArcRuns.readMembership")(function* (
    ctx: RunContext,
    fresh: boolean,
  ) {
    const key = `${ctx.connection.connection}\n${ctx.run.arc.number}`;
    return yield* lock.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const writeVersion = yield* weave.buildWriteVersion;
        const previous = membership.get(key);
        if (
          !fresh &&
          previous !== undefined &&
          previous.writeVersion === writeVersion &&
          now - previous.attemptedAt < previous.intervalMs
        )
          return previous;
        const read = yield* weave
          .observe("weave_forge_read", { number: ctx.run.arc.number })
          .pipe(Effect.option);
        const arc = Option.isSome(read)
          ? decodeArc(read.value.value)
          : Option.none<typeof Arc.Type>();
        const numbers = new Set<number>();
        const ids = new Set<string>();
        let complete = Option.isSome(arc);
        if (Option.isSome(arc)) {
          let cursor: string | null = null;
          let limit = 15;
          const cursors = new Set<string>();
          for (;;) {
            const page: { result: Option.Option<typeof Backlinks.Type>; tooLarge: boolean } =
              yield* weave
                .observe("weave_graph_backlinks", {
                  node: { kind: "record", id: arc.value.id },
                  roles: ["tagged"],
                  limit,
                  ...(cursor === null ? {} : { cursor }),
                })
                .pipe(
                  Effect.map((result) => ({
                    result: decodeBacklinks(result.value),
                    tooLarge: false,
                  })),
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning("Arc membership observer failed", {
                        reason: cause.reason,
                        code: cause.code,
                      });
                      return {
                        result: Option.none<typeof Backlinks.Type>(),
                        tooLarge: cause.code === "mcp_result_too_large",
                      };
                    }),
                  ),
                );
            if (page.tooLarge && limit > 1) {
              limit = Math.max(1, Math.floor(limit / 2));
              continue;
            }
            if (Option.isNone(page.result)) {
              complete = false;
              break;
            }
            for (const { node } of page.result.value.links) {
              if (!node.available) complete = false;
              else if (node.object === "spec") {
                if (node.node === undefined || node.number === undefined) complete = false;
                else if (!ids.has(node.node.id)) {
                  ids.add(node.node.id);
                  numbers.add(node.number);
                }
              }
            }
            cursor = page.result.value.cursor;
            if (cursor === null) break;
            if (cursors.has(cursor)) {
              complete = false;
              break;
            }
            cursors.add(cursor);
          }
        }
        const value = {
          arc: Option.isSome(arc)
            ? {
                number: arc.value.number,
                ...(arc.value.ref === undefined ? {} : { ref: arc.value.ref }),
                title: arc.value.title,
                url: forgeItemUrl(ctx.connection.origin, arc.value.number),
              }
            : (previous?.arc ?? {
                number: ctx.run.arc.number,
                ...(ctx.run.arc.ref === undefined ? {} : { ref: ctx.run.arc.ref }),
                title: ctx.run.arc.ref ?? `#${ctx.run.arc.number}`,
                url: forgeItemUrl(ctx.connection.origin, ctx.run.arc.number),
              }),
          goal: Option.isSome(arc) ? (arc.value.summary ?? null) : (previous?.goal ?? null),
          numbers: [...numbers],
          complete,
          read: Option.isSome(arc),
        };
        const fingerprint = complete ? ForgeWorkItems.fingerprintOf(value) : undefined;
        const next: Membership = {
          ...value,
          fingerprint,
          writeVersion,
          attemptedAt: now,
          intervalMs: ForgeWorkItems.nextInterval(previous, fingerprint),
        };
        remember(membership, key, next);
        return next;
      }),
    );
  });
  const summary: ForgeArcRuns["Service"]["summary"] = Effect.fn("ForgeArcRuns.summary")(
    function* (input) {
      const ctx = yield* context(input);
      if (ctx === null) return null;
      const members = yield* readMembership(ctx, false);
      const numbers = ctx.run.specs ?? members.numbers;
      const views =
        numbers.length === 0
          ? { items: [] }
          : yield* workItems.mentions({ threadId: input.threadId, numbers });
      const specs = views.items.filter((view) => view.item?.kind === "spec");
      return {
        arc: members.arc,
        landed: specs.filter(
          (view) => view.item?.status === "landed" || view.item?.status === "accepted",
        ).length,
        total: specs.filter((view) => view.item?.status !== "dropped").length,
        complete:
          members.complete &&
          specs.length === numbers.length &&
          !views.unavailable &&
          specs.every((view) => !view.unavailable),
        readAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      };
    },
  );
  const detail: ForgeArcRuns["Service"]["detail"] = Effect.fn("ForgeArcRuns.detail")(
    function* (input) {
      const ctx = yield* context(input);
      if (ctx === null) return null;
      const key = `${ctx.connection.connection}\n${input.threadId}\n${input.arc}`;
      return yield* lock.withLock(
        `detail\n${key}`,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const writeVersion = yield* weave.buildWriteVersion;
          const previous = details.get(key);
          const runFingerprint = ForgeWorkItems.fingerprintOf(ctx.run);
          if (
            previous !== undefined &&
            previous.opens.includes(`${input.open}\n${runFingerprint}`) &&
            previous.writeVersion === writeVersion &&
            now - previous.attemptedAt < previous.intervalMs
          )
            return previous.value;
          const members = yield* readMembership(ctx, true);
          const numbers = [
            ...new Set([...members.numbers, ...(ctx.run.specs ?? []), ...(ctx.run.plan ?? [])]),
          ];
          const views =
            numbers.length === 0
              ? { items: [] }
              : yield* workItems.mentions({ threadId: input.threadId, numbers }, { fresh: true });
          if (!members.read && views.items.length === 0) {
            if (previous === undefined) return yield* unavailable();
            const value = { ...previous.value, complete: false };
            remember(details, key, {
              value,
              fingerprint: undefined,
              writeVersion,
              attemptedAt: now,
              intervalMs: ForgeWorkItems.BUILD_REREAD_INTERVAL_MS,
              opens: [`${input.open}\n${runFingerprint}`, ...previous.opens].slice(0, 32),
            });
            return value;
          }
          const otherRuns = yield* projections
            .listArcRunThreads()
            .pipe(Effect.mapError(unavailable));
          const childIds = yield* projections
            .listAppOwnedChildThreadIds(input.threadId)
            .pipe(Effect.mapError(unavailable));
          const children = yield* Effect.forEach(childIds, (id) =>
            projections.getThread(id).pipe(Effect.mapError(unavailable)),
          );
          const specs = views.items.flatMap((view) => {
            if (view.item?.kind !== "spec") return [];
            const child = children.find(
              (thread) =>
                thread.deletedAt === null &&
                thread.lineage.parentThreadId === input.threadId &&
                thread.agentTask?.role === "lead" &&
                thread.workItem?.itemId === view.itemId &&
                sameWeaveAddress(thread.workItem.origin, ctx.connection.origin),
            );
            const other = otherRuns.find(
              (thread) =>
                thread.id !== input.threadId &&
                thread.deletedAt === null &&
                thread.arcRun?.arc.number === input.arc &&
                arcRunScopesOverlap(thread.arcRun.specs, [view.number]),
            );
            const thread: ForgeArcRunSpecThread | null =
              child !== undefined
                ? { threadId: child.id, title: child.title, relation: "spec-lead" }
                : other !== undefined
                  ? { threadId: other.id, title: other.title, relation: "other-run" }
                  : null;
            return [
              {
                number: view.number,
                ...(view.item.ref === undefined ? {} : { ref: view.item.ref }),
                title: view.item.title,
                status: view.item.status,
                url: view.url,
                holds: view.item.holds,
                waits: view.item.waits,
                inArc: members.numbers.includes(view.number),
                thread,
              },
            ];
          });
          const value = {
            arc: members.arc,
            goal: members.goal,
            specs,
            complete:
              members.complete &&
              !views.unavailable &&
              specs.length === numbers.length &&
              views.items.every((view) => !view.unavailable),
            readAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          };
          const fingerprint = ForgeWorkItems.fingerprintOf({ ...value, readAt: undefined });
          remember(details, key, {
            value,
            fingerprint,
            writeVersion,
            attemptedAt: now,
            intervalMs: ForgeWorkItems.nextInterval(previous, fingerprint),
            opens: [`${input.open}\n${runFingerprint}`, ...(previous?.opens ?? [])].slice(0, 32),
          });
          return value;
        }),
      );
    },
  );
  return ForgeArcRuns.of({ summary, detail });
});
export const layer = Layer.effect(ForgeArcRuns, make);
