import type * as NodeWorkerThreads from "node:worker_threads";
import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { vi } from "vite-plus/test";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const workerStatements = vi.hoisted(
  (): Array<{ readonly readOnly: boolean; readonly sql: string }> => [],
);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    readonly #readOnly: boolean;
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      this.#readOnly = args[1]?.workerData?.readOnly === true;
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [message] = args;
      if (typeof message === "object" && message !== null && typeof message.sql === "string") {
        workerStatements.push({ readOnly: this.#readOnly, sql: message.sql });
      }
      return super.postMessage(...args);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerEffectOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
  Layer.provide(layerDatabase),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerDatabase),
);
const layerProjectionReplayProvided = ProjectionReplay.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerEffectOutboxProvided,
  layerCommandReceiptStoreProvided,
  IdAllocator.layer,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
);

it.layer(layerTest)("orchestration V2 foundation persistence", (it) => {
  it.effect("starts a follow-up turn while the previous run's tab release waits", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:foundation-release-effect-lane");
      const threadId = ThreadId.make("thread:foundation-release-effect-lane");
      const providerEffectId = "effect:foundation-release-effect-lane:b-provider";
      yield* outbox.enqueue([
        {
          id: "effect:foundation-release-effect-lane:a-release",
          commandId,
          threadId,
          request: {
            type: "browser-sessions.release",
            sourceRunId: RunId.make("run:foundation-release-effect-lane:1"),
          },
          availableAt: DateTime.add(now, { minutes: 10 }),
        },
        {
          id: providerEffectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-release-effect-lane:2"),
          },
        },
      ]);

      const provider = yield* outbox.claimNext({
        workerId: "release-lane-worker",
      });
      assert.isTrue(Option.isSome(provider));
      if (Option.isSome(provider)) {
        assert.equal(provider.value.id, providerEffectId);
        yield* outbox.succeed({ effectId: provider.value.id, workerId: "release-lane-worker" });
      }
    }),
  );
});
