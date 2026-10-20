import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessGroupLedger from "@t3tools/provider-core/server/ProcessGroupLedger";

export class OpenCodeServerLedger extends Context.Service<
  OpenCodeServerLedger,
  {
    readonly track: (server: {
      readonly pid: number;
      readonly port: number;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeServerLedger") {}

export const layer = Layer.effect(
  OpenCodeServerLedger,
  Effect.map(ProcessGroupLedger.ProcessGroupLedger, (ledger) =>
    OpenCodeServerLedger.of({ track: ({ pid, args }) => ledger.track({ pid, args }) }),
  ),
);

export const layerTest = Layer.succeed(
  OpenCodeServerLedger,
  OpenCodeServerLedger.of({ track: () => Effect.succeed(Effect.void) }),
);
