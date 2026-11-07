import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../Orchestrator.ts";

/**
 * Reads `read` now and again after each event `orchestrator` stores, until
 * `holds` accepts it. A failed read counts as not yet, as for a thread another
 * fiber has not created. Every stored event is replayed, so none is missed.
 */
export const awaitOrchestratorState = <A, E>(
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  read: Effect.Effect<A, E>,
  holds: (value: A) => boolean,
) =>
  Stream.concat(
    Stream.succeed(undefined),
    orchestrator.streamStoredEventsFrom({ afterSequence: 0 }),
  ).pipe(
    Stream.mapEffect(() => read.pipe(Effect.option)),
    Stream.filter((value) => Option.isSome(value) && holds(value.value)),
    Stream.runHead,
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error("The orchestrator stopped before the state came.")),
        onSome: Effect.succeed,
      }),
    ),
  );
