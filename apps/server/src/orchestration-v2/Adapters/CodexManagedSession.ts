import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

/**
 * A managed task's thread starts with every MCP server its Codex configuration enables turned
 * off, so it reaches only the servers T3 attaches. Other threads' params pass through.
 */
export const withManagedMcpServersDisabled = <
  P extends { readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined },
  E,
  R,
>(
  params: P,
  readConfiguredServers: (cwd: string | null) => Effect.Effect<unknown, E, R>,
): Effect.Effect<P & { readonly disabledMcpServers?: ReadonlyArray<string> }, E, R> =>
  params.runtimePolicy?.managedAgent !== true
    ? Effect.succeed(params)
    : readConfiguredServers(params.runtimePolicy.cwd).pipe(
        Effect.map((servers) => ({
          ...params,
          disabledMcpServers:
            servers !== null && typeof servers === "object" && !Array.isArray(servers)
              ? Object.keys(servers)
              : [],
        })),
      );

/**
 * Runs `open` between two reads of the account's usage identity. The identity is kept only when
 * both reads agree, so usage reported by a session that opened across a login change is not
 * credited to either account.
 */
export const withStableUsageIdentity = Effect.fn("CodexManagedSession.withStableUsageIdentity")(
  function* <A, E, R>(
    readUsageIdentity: Effect.Effect<string | undefined> | undefined,
    open: Effect.Effect<A, E, R>,
  ) {
    const read = readUsageIdentity ?? Effect.undefined;
    const before = yield* read;
    const value = yield* open;
    const after = yield* read;
    return { value, usageIdentity: before !== undefined && before === after ? after : undefined };
  },
);
