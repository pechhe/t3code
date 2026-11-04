// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off anyUnknownInErrorContext:off - Evaluation-only host script (wall-clock measurements, pacing and files); the server service is loaded by path, so its channels are untyped here.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const PREVIEW_PROJECT = "a637c6bc-9c23-43c3-bfb0-b4eb00414d23";

/**
 * Reads the two authorised keys from bws into a ConfigProvider's memory only: never argv, env of
 * a child, a file or a log. `bws secret list` runs once per process.
 */
export function readAuthorisedKeys(): Record<string, string> {
  const listed = JSON.parse(
    NodeChildProcess.execFileSync("bws", ["secret", "list"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as ReadonlyArray<{ key: string; value: string; projectId: string }>;
  const find = (key: string, projectId?: string) =>
    listed.find((s) => s.key === key && (projectId === undefined || s.projectId === projectId))
      ?.value;
  const jev = find("TYPESAFE_API_KEY");
  const luna = find("WEAVE__OPENAI_API_KEY", PREVIEW_PROJECT);
  if (!jev || !luna) throw new Error("authorised decision keys are not available in bws");
  return { TYPESAFE_API_KEY: jev, OPENAI_API_KEY: luna };
}

export type Decide = (input: unknown) => Promise<unknown>;

/** The shared DecisionService with an HTTP client and in-memory credentials; no other adapter. */
const SERVER_SRC = new URL("../../../apps/server/src/", import.meta.url);

export async function makeDecide(keys: Record<string, string>): Promise<Decide> {
  // Loaded by path so the scripts project does not compile the server's sources.
  const ServerSecretStore = (await import(
    new URL("auth/ServerSecretStore.ts", SERVER_SRC).href
  )) as {
    ServerSecretStore: Parameters<typeof Layer.mock>[0];
  };
  const DecisionService = (await import(
    new URL("decisions/DecisionService.ts", SERVER_SRC).href
  )) as {
    layer: Layer.Layer<any, any, any>;
    DecisionService: {
      use: (
        f: (service: {
          decide: (input: unknown) => Effect.Effect<unknown, unknown>;
        }) => Effect.Effect<unknown, unknown>,
      ) => Effect.Effect<unknown, unknown, any>;
    };
  };
  const layer = DecisionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeHttpClient.layerFetch,
        NodeServices.layer,
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeedNone,
        } as never),
      ),
    ),
  );
  // One runtime keeps the service's admission window and its 60/min limit across calls.
  const runtime = ManagedRuntime.make(layer);
  return (input) =>
    runtime
      .runPromise(
        DecisionService.DecisionService.use((service) => service.decide(input)).pipe(
          // Config is read at call time from the fiber, so the keys travel with each call.
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(keys))),
          Effect.result,
        ),
      )
      .then((result) =>
        result._tag === "Success"
          ? { ok: true, result: result.success }
          : { ok: false, error: result.failure },
      );
}
