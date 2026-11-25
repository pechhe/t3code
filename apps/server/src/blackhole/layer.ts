import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as BlackholeMemoryStore from "./BlackholeMemoryStore.ts";
import * as BlackholeService from "./BlackholeService.ts";

/** Blackhole's reads of a thread: its session, compaction and recall. */
export const layerBlackhole = BlackholeService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(BlackholeMemoryStore.layer, ProjectionStore.layer, ProjectStore.layer),
  ),
);
