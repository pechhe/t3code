import type { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

/**
 * A T3-owned HTTP MCP server a thread's agent reaches beside `t3-code`, such as Weave's
 * `weave` (with its retained `yardsmith-hq` alias). The server decides what this agent may do, by the identity its credential is
 * bound to, so adapters attach it without an approval prompt for its tools. The header carries a
 * credential T3 issued for this thread alone, never the upstream service's own secret.
 */
export interface AgentMcpServer {
  readonly name: string;
  readonly url: string;
  readonly authorizationHeader: string;
}

/**
 * The one list every adapter attaches: the server owns which servers a thread gets and their
 * lifecycle, and each adapter only translates the list into its provider's own MCP config.
 */
export class AgentMcpServers extends Context.Service<
  AgentMcpServers,
  {
    readonly read: (
      threadId: ThreadId,
      registration?: Registration,
    ) => Effect.Effect<ReadonlyArray<AgentMcpServer>>;
  }
>()("@t3tools/provider-core/server/AgentMcpServers") {}

/** Reads the thread's servers through the environment's service, or none where it has none. */
export const makeReader = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(AgentMcpServers);
  return (threadId: ThreadId | null | undefined): Effect.Effect<ReadonlyArray<AgentMcpServer>> =>
    threadId === null || threadId === undefined || Option.isNone(service)
      ? Effect.succeed([])
      : Effect.flatMap(CurrentRegistration, (registration) =>
          service.value.read(threadId, registration),
        );
});

export type Registration = "canonical" | "legacy";

/** Bound by the session manager at launch and at each native-thread operation. */
export class CurrentRegistration extends Context.Reference<Registration>(
  "@t3tools/provider-core/server/AgentMcpServers/CurrentRegistration",
  { defaultValue: () => "canonical" },
) {}

export const registrationForThread = (
  thread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef" | "nativeMetadata">,
): Registration =>
  thread.nativeThreadRef === null
    ? "canonical"
    : (thread.nativeMetadata?.agentMcpRegistration ?? "legacy");

const markRegistration = (
  thread: OrchestrationV2ProviderThread,
  registration: Registration,
): OrchestrationV2ProviderThread => ({
  ...thread,
  nativeMetadata: { ...thread.nativeMetadata, agentMcpRegistration: registration },
});

/** Restores durable registration policy around adapters, including their asynchronous thread events. */
export const bindRuntime = (
  runtime: ProviderAdapterV2SessionRuntime,
): ProviderAdapterV2SessionRuntime => {
  // Event rows may omit metadata; remember the durable choice by native identity, including late events.
  const registrations = new Map<string, Registration>();
  const key = (thread: OrchestrationV2ProviderThread) =>
    thread.nativeThreadRef?.nativeId ?? thread.id;
  const bind = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    thread: OrchestrationV2ProviderThread | undefined,
    registration: Registration,
  ) =>
    Effect.suspend(() => {
      if (thread !== undefined) registrations.set(key(thread), registration);
      return effect.pipe(Effect.provideService(CurrentRegistration, registration));
    });
  const mark = (thread: OrchestrationV2ProviderThread, registration: Registration) => {
    registrations.set(key(thread), registration);
    return markRegistration(thread, registration);
  };
  return {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
    events: runtime.events.pipe(
      Stream.map((event) => {
        if (event.type !== "provider_thread.updated") return event;
        const registration = registrations.get(key(event.providerThread));
        return registration === undefined
          ? event
          : {
              ...event,
              providerThread: mark(event.providerThread, registration),
            };
      }),
    ),
    ensureThread: (input) => {
      const registration =
        input.existingProviderThread === undefined
          ? "canonical"
          : registrationForThread(input.existingProviderThread);
      return bind(runtime.ensureThread(input), input.existingProviderThread, registration).pipe(
        Effect.map((thread) => mark(thread, registration)),
      );
    },
    resumeThread: (input) => {
      const registration = registrationForThread(input.providerThread);
      return bind(runtime.resumeThread(input), input.providerThread, registration).pipe(
        Effect.map((thread) => mark(thread, registration)),
      );
    },
    forkThread: (input) => {
      const registration = registrationForThread(input.sourceProviderThread);
      return bind(runtime.forkThread(input), input.sourceProviderThread, registration).pipe(
        Effect.map((thread) => mark(thread, registration)),
      );
    },
    startTurn: (input) =>
      bind(
        runtime.startTurn(input),
        input.providerThread,
        registrationForThread(input.providerThread),
      ),
    ...(runtime.compactThread === undefined
      ? {}
      : {
          compactThread: (
            input: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["compactThread"]>>[0],
          ) =>
            bind(
              runtime.compactThread!(input),
              input.providerThread,
              registrationForThread(input.providerThread),
            ),
        }),
    ...(runtime.injectHistory === undefined
      ? {}
      : {
          injectHistory: (
            input: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["injectHistory"]>>[0],
          ) =>
            bind(
              runtime.injectHistory!(input),
              input.providerThread,
              registrationForThread(input.providerThread),
            ),
        }),
    steerTurn: (input) =>
      bind(
        runtime.steerTurn(input),
        input.providerThread,
        registrationForThread(input.providerThread),
      ),
    interruptTurn: (input) =>
      bind(
        runtime.interruptTurn(input),
        input.providerThread,
        registrationForThread(input.providerThread),
      ),
    readThreadSnapshot: (input) => {
      const registration = registrationForThread(input.providerThread);
      return bind(runtime.readThreadSnapshot(input), input.providerThread, registration).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          providerThread: mark(snapshot.providerThread, registration),
        })),
      );
    },
    rollbackThread: (input) => {
      const registration = registrationForThread(input.providerThread);
      return bind(runtime.rollbackThread(input), input.providerThread, registration).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          providerThread: mark(snapshot.providerThread, registration),
        })),
      );
    },
  };
};
