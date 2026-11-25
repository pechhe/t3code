import {
  compileCompaction,
  recall,
  type CompactionResult,
  type RecallParams,
} from "@t3tools/blackhole";
import {
  type BlackholeSettings,
  currentProviderInstanceId,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  readInheritedHandoffItems,
  visibleConversationItems,
} from "../orchestration-v2/ContextHandoffService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as BlackholeMemoryStore from "./BlackholeMemoryStore.ts";
import { BLACKHOLE_ITEM_TYPES, buildSession } from "./BlackholeSession.ts";

/** Pi threads keep the pi-blackhole extension; T3 runs Blackhole for every other harness. */
const EXTENSION_DRIVERS = new Set(["pi"]);

const driverOf = (settings: ServerSettings, instanceId: ProviderInstanceId): string => {
  const current = currentProviderInstanceId(settings, instanceId);
  // A default instance with no configured entry is named after its driver.
  return Object.hasOwn(settings.providerInstances, current)
    ? (settings.providerInstances[current]?.driver ?? current)
    : current;
};

/** T3 compacts this driver's threads with Blackhole. */
export const blackholeCompacts = (blackhole: BlackholeSettings, driver: string): boolean =>
  blackhole.compaction && !EXTENSION_DRIVERS.has(driver);

/** T3 runs Blackhole's memory workers on this driver's threads. */
export const blackholeRemembers = (blackhole: BlackholeSettings, driver: string): boolean =>
  blackhole.memory &&
  !EXTENSION_DRIVERS.has(driver) &&
  !blackhole.memoryOffDrivers.includes(driver);

export class BlackholeService extends Context.Service<
  BlackholeService,
  {
    /** The driver of the thread's provider instance and the Blackhole settings in force. */
    readonly settingsFor: (threadId: ThreadId) => Effect.Effect<{
      readonly blackhole: BlackholeSettings;
      readonly driver: string;
    }>;
    /** Blackhole's compaction of the thread as it stands, or undefined when there is nothing. */
    readonly compile: (threadId: ThreadId) => Effect.Effect<CompactionResult | undefined>;
    readonly recall: (threadId: ThreadId, params: RecallParams) => Effect.Effect<string>;
    /** The thread as Blackhole reads it, and the item its newest entry came from. */
    readonly session: (threadId: ThreadId) => Effect.Effect<ReturnType<typeof buildSession>>;
    /** Where the thread works, for the Utility model's runner. */
    readonly cwdOf: (threadId: ThreadId) => Effect.Effect<string>;
  }
>()("t3/blackhole/BlackholeService") {}

export const layer = Layer.effect(
  BlackholeService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettingsService.ServerSettingsService;
    const store = yield* BlackholeMemoryStore.BlackholeMemoryStore;

    const settings = serverSettings.getSettings.pipe(Effect.orDie);

    const settingsFor = Effect.fn("BlackholeService.settingsFor")(function* (threadId: ThreadId) {
      const current = yield* settings;
      const thread = yield* projections.getThread(threadId).pipe(Effect.orDie);
      return { blackhole: current.blackhole, driver: driverOf(current, thread.providerInstanceId) };
    });

    const cwdOf = Effect.fn("BlackholeService.cwdOf")(function* (threadId: ThreadId) {
      const thread = yield* projections.getThread(threadId).pipe(Effect.orDie);
      if (thread.worktreePath !== null) return thread.worktreePath;
      const project = yield* projects
        .get(thread.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.match(project, { onNone: () => "", onSome: (found) => found.workspaceRoot });
    });

    const session = Effect.fn("BlackholeService.session")(function* (threadId: ThreadId) {
      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "attempts"])
        .pipe(Effect.orDie);
      const history = yield* projections
        .getTurnStartHistory(threadId, undefined, BLACKHOLE_ITEM_TYPES)
        .pipe(Effect.orDie);
      // A fork carries its ancestors' history and the memory written at it, as its messages do.
      const kept = new Set(BLACKHOLE_ITEM_TYPES);
      const inherited = (yield* readInheritedHandoffItems(projections, records.thread).pipe(
        Effect.orDie,
      )).filter((item) => kept.has(item.type));
      const ancestors = [...new Set(inherited.map((item) => item.threadId))];
      const inheritedMemory = yield* Effect.forEach(ancestors, (ancestor) =>
        store
          .list(ancestor)
          .pipe(Effect.map((rows) => rows.map((row) => ({ ...row, inheritedFrom: ancestor })))),
      );
      const own = yield* store.list(threadId);
      return buildSession({
        items: [...inherited, ...visibleConversationItems(records, history)],
        records: [...inheritedMemory.flat(), ...own],
      });
    });

    const compile = Effect.fn("BlackholeService.compile")(function* (threadId: ThreadId) {
      const { blackhole, driver } = yield* settingsFor(threadId);
      const { entries } = yield* session(threadId);
      const cwd = yield* cwdOf(threadId);
      return compileCompaction({ entries, cwd, memory: blackholeRemembers(blackhole, driver) });
    });

    const recallIn = Effect.fn("BlackholeService.recall")(function* (
      threadId: ThreadId,
      params: RecallParams,
    ) {
      const { entries } = yield* session(threadId);
      return yield* Effect.promise(() => recall(entries, params));
    });

    return BlackholeService.of({
      settingsFor,
      compile,
      recall: recallIn,
      session,
      cwdOf,
    });
  }),
);
