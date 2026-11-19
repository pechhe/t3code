import type * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as Effect from "effect/Effect";

interface ReopenableSession {
  readonly providerSession?:
    | {
        readonly capabilities: {
          readonly sessions: { readonly supportsMultipleProviderThreadsPerSession?: boolean };
        };
      }
    | undefined;
}

/**
 * Before a recovery starts a fresh native thread, a session launched with a legacy MCP catalogue
 * is reopened with the canonical one (fork/differences.md `session-tool-listings`): a launch-time
 * catalogue cannot change with only a new native thread id. Reopening would abandon pending
 * background work on a single-thread session, so that refuses instead.
 */
export const reopenWithCanonicalCatalogue = Effect.fn(
  "ProviderTurnStartService.reopenWithCanonicalCatalogue",
)(function* <S extends ReopenableSession, EBackground, EOpen, EStatus, EResume>(input: {
  readonly initialRegistration: AgentMcpServers.Registration;
  readonly session: S;
  readonly pendingBackgroundWork: Effect.Effect<boolean, EBackground> | undefined;
  readonly resumeFailure: EResume | undefined;
  readonly isStarting: Effect.Effect<boolean, EStatus>;
  readonly openCanonical: Effect.Effect<S, EOpen>;
}) {
  if (input.initialRegistration === "canonical") return { _tag: "Kept" } as const;
  if (
    input.session.providerSession?.capabilities.sessions
      .supportsMultipleProviderThreadsPerSession !== true &&
    input.pendingBackgroundWork !== undefined &&
    (yield* input.pendingBackgroundWork)
  ) {
    return {
      _tag: "Refused",
      retry: input.resumeFailure,
      signal: "provider-thread-load-failure",
      title: "Provider turn failed to start",
      error:
        input.resumeFailure ?? new Error("Provider restart would abandon pending background work."),
    } as const;
  }
  if (!(yield* input.isStarting)) return { _tag: "Stopped" } as const;
  const reopened = yield* Effect.result(input.openCanonical);
  if (reopened._tag === "Failure") {
    return {
      _tag: "Refused",
      retry: reopened.failure,
      signal: "provider-session-open-failure",
      title: "Provider session failed to open",
      error: reopened.failure,
    } as const;
  }
  if (!(yield* input.isStarting)) return { _tag: "Stopped" } as const;
  return { _tag: "Reopened", session: reopened.success } as const;
});
