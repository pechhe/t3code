import { FleetSummary, type EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PeerEnvironments from "./PeerEnvironments.ts";
const decodeSummary = Schema.decodeUnknownEffect(FleetSummary);

export class FleetPeers extends Context.Service<
  FleetPeers,
  {
    readonly read: (cursors: Readonly<Record<string, string>>) => Effect.Effect<
      ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly summary: FleetSummary | null;
        readonly reason: string | null;
      }>,
      import("@t3tools/contracts").PeerEnvironmentError
    >;
  }
>()("t3/peers/FleetPeers") {}

const make = Effect.gen(function* () {
  const peers = yield* PeerEnvironments.PeerEnvironments;
  return FleetPeers.of({
    read: (cursors) =>
      peers.stored.pipe(
        Effect.map((stored) =>
          stored.map((peer) => ({
            environmentId: peer.environmentId,
            label: peer.label,
          })),
        ),
        Effect.flatMap((linked) =>
          Effect.forEach(
            linked,
            (peer) =>
              peers
                .callTool({
                  environmentId: peer.environmentId,
                  name: "t3_fleet_summary",
                  arguments:
                    cursors[peer.environmentId] === undefined
                      ? {}
                      : { changedSince: cursors[peer.environmentId] },
                })
                .pipe(
                  Effect.flatMap((result) =>
                    result.isError
                      ? Effect.succeed({ ...peer, summary: null, reason: "unsupported" })
                      : decodeSummary(result.structuredContent).pipe(
                          Effect.map((summary) => ({ ...peer, summary, reason: null })),
                          Effect.orElseSucceed(() => ({
                            ...peer,
                            summary: null,
                            reason: "unsupported",
                          })),
                        ),
                  ),
                  Effect.catchTags({
                    PeerCallError: (error) =>
                      Effect.succeed({ ...peer, summary: null, reason: error.status }),
                    PeerEnvironmentError: () =>
                      Effect.succeed({ ...peer, summary: null, reason: "offline" }),
                  }),
                ),
            { concurrency: 4 },
          ),
        ),
      ),
  });
});
export const layer = Layer.effect(FleetPeers, make);
