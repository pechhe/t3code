import type { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const STATUS_KEY = "blackhole";

/**
 * Blackhole's status line per provider session, kept where the harness's own session updates
 * pick it up: their sessions carry no extension statuses, so without this each update would
 * clear the line the context bar reads (the same key and format pi-blackhole writes on Pi).
 */
export class BlackholeStatusBoard extends Context.Service<
  BlackholeStatusBoard,
  {
    readonly set: (providerSessionId: string, text: string) => void;
    readonly withStatus: (
      session: OrchestrationV2ProviderSession,
    ) => OrchestrationV2ProviderSession;
  }
>()("t3/blackhole/BlackholeStatusBoard") {}

export const layer = Layer.sync(BlackholeStatusBoard, () => {
  const texts = new Map<string, string>();
  return BlackholeStatusBoard.of({
    set: (providerSessionId, text) => void texts.set(providerSessionId, text),
    withStatus: (session) => {
      const text = texts.get(session.id);
      if (text === undefined || session.driver === "pi") return session;
      return {
        ...session,
        extensionStatuses: [
          ...(session.extensionStatuses ?? []).filter((status) => status.key !== STATUS_KEY),
          { key: STATUS_KEY, text },
        ],
      };
    },
  });
});
