import {
  DEFAULT_AGENT_BROWSER_BACKENDS,
  isLeafAgentTask,
  type EnvironmentId,
  type OrchestrationV2LinkOrigin,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { assertNotLinked, assertSameLink, callerLinkOrigin } from "./linkOrigin.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  assertBoundedBrowserCaller,
  assertManagedBrowserCaller,
  assertProjectBrowserAccess,
  drivesOwnBrowser,
  listsBrowserFamily,
} from "./ManagedBrowserAccess.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import {
  assertFullAccess,
  assertExternalWorkOwner,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/** Private constructors only enforce types; the token also blocks runtime construction. */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  remote: RemoteCheck<P> | undefined,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

/**
 * What a call bound for a linked environment checks here before it goes: the
 * caller, not the thread or project it names, which live there and are
 * checked there. `undefined` for tools that act as the calling thread itself.
 */
type RemoteCheck<P> = (
  params: P,
) => Effect.Effect<unknown, OrchestratorMcpFailure, Effect.Services<typeof writingCaller>>;
let remoteCheckOf: <Handler>(declaration: Declaration<Handler>) => RemoteCheck<never> | undefined;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/** t3code/no-raw-mcp-registration confines Effect's unchecked registration API to McpHttpServer. */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly #remote: RemoteCheck<never> | undefined;
  private constructor(
    token: typeof builtHere,
    handle: Handler,
    remote: RemoteCheck<never> | undefined,
  ) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.#remote = remote;
  }
  static {
    declare = (handle, remote) => new Declaration(builtHere, handle, remote);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
    remoteCheckOf = (declaration) => declaration.#remote;
  }
}

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client !== undefined && McpInvocationContext.isReadOnlyClient(scope.client)
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

/**
 * The caller of a tool that changes something. Tools that act for a
 * capability of their own (preview, device, worktree, pull requests) check it
 * themselves.
 */
const refuseManagedChildWrites = ({ caller }: Caller) =>
  !isLeafAgentTask(caller?.agentTask)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Managed workers are leaf tasks and cannot change T3 state or delegate.",
        }),
      );

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
  Effect.tap(refuseManagedChildWrites),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
  Effect.tap(refuseManagedChildWrites),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) => handle(params),
    () => Effect.void,
  );

/**
 * A browser task uses its pinned backend; children without browser tools remain leaf-restricted.
 * Closing skips the settings check so cleanup survives revoked access.
 */
const previewActionScope = Effect.fn("mcp.previewActionScope")(function* (
  caller: Caller,
  options: { readonly checkSettings: boolean },
) {
  if (!drivesOwnBrowser(caller)) {
    yield* refuseManagedChildWrites(caller);
    return caller.scope;
  }
  if (options.checkSettings) yield* assertProjectBrowserAccess(caller);
  return {
    ...caller.scope,
    browserBackends: caller.scope.browserBackends ?? DEFAULT_AGENT_BROWSER_BACKENDS,
  } satisfies McpInvocationContext.McpInvocationScope;
});

const previewCaller = (options: { readonly checkSettings: boolean }) =>
  refuseReadOnlyClient.pipe(
    Effect.andThen(loadCaller()),
    Effect.tap(assertLiveCaller),
    Effect.flatMap((caller) => previewActionScope(caller, options)),
  );

/**
 * Preview reads keep the credential's backend. Legacy reads retain their cleanup access;
 * the managed endpoint checks settings on reads as well as actions.
 */
export const readsAsPreviewCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.flatMap((scope) =>
          Effect.provideService(
            handle(params),
            McpInvocationContext.McpInvocationContext,
            listsBrowserFamily(scope)
              ? {
                  ...scope,
                  browserBackends: scope.browserBackends ?? DEFAULT_AGENT_BROWSER_BACKENDS,
                }
              : scope,
          ),
        ),
      ),
    undefined,
  );

/**
 * One action on the caller's own browser. Tab ownership is unchanged: the broker keys tabs to the
 * caller's own session and the backend refuses another session's tab. Only the operations Phi
 * supports use this declaration; raw page code, uploads, recordings and appearance changes stay
 * `actsAsCaller`.
 */
export const actsAsPreviewCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.flatMap(() => previewCaller({ checkSettings: true })),
        Effect.flatMap((scope) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
        ),
      ),
    undefined,
  );

/** Closing a tab stays possible after the project's browser access is revoked. */
export const cleansUpAsPreviewCaller = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.flatMap(() => previewCaller({ checkSettings: false })),
        Effect.flatMap((scope) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
        ),
      ),
    undefined,
  );

/**
 * A managed browser task's own tab tools, on the `/mcp/browser` endpoint only. The credential,
 * the task's backend pin and the project's browser settings are checked on every call.
 */
export const asManagedBrowser = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      assertManagedBrowserCaller({ checkSettings: true }).pipe(
        Effect.tap(assertLiveCaller),
        Effect.flatMap((caller) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, {
            ...caller.scope,
            managedProjectId: caller.caller!.projectId,
          }),
        ),
      ),
    undefined,
  );

/** Closing a managed browser task's tab stays possible after its browser access is revoked. */
export const cleansUpAsManagedBrowser = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      assertManagedBrowserCaller({ checkSettings: false }).pipe(
        Effect.tap(assertLiveCaller),
        Effect.flatMap((caller) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, {
            ...caller.scope,
            managedProjectId: caller.caller!.projectId,
          }),
        ),
      ),
    undefined,
  );

/** A bounded browser call acts with its derived scope: the thread's own bounded integrated lane. */
export const asBoundedBrowser = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      assertBoundedBrowserCaller({ checkSettings: true }).pipe(
        Effect.flatMap(({ scope }) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
        ),
      ),
    undefined,
  );

/** Closing a bounded tab or cancelling its task stays possible after browser access is revoked. */
export const cleansUpAsBoundedBrowser = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      assertBoundedBrowserCaller({ checkSettings: false }).pipe(
        Effect.flatMap(({ scope }) =>
          Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
        ),
      ),
    undefined,
  );

/** External clients read their owned tasks; T3 callers retain the existing live-run gate. */
export const readsTask = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          scope.thread === undefined && scope.client !== undefined
            ? handle(params)
            : requireThreadCaller.pipe(
                Effect.andThen(writingCaller),
                Effect.flatMap(() => handle(params)),
              ),
        ),
      ),
    undefined,
  );

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))), undefined);

/**
 * Opening or closing a simulator for the caller's own thread. A browser task may, as its device
 * capability allows; other managed leaves stay refused. The handler checks the capability.
 */
export const actsAsDeviceCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.andThen(refuseReadOnlyClient),
        Effect.andThen(loadCaller()),
        Effect.tap(assertLiveCaller),
        Effect.tap((caller) =>
          drivesOwnBrowser(caller) ? Effect.void : refuseManagedChildWrites(caller),
        ),
        Effect.flatMap(() => handle(params)),
      ),
    undefined,
  );

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      requireThreadCaller.pipe(
        Effect.andThen(writingCaller),
        Effect.flatMap(() => handle(params)),
      ),
    undefined,
  );

/**
 * Changes something that belongs to no thread, such as a pending upload or a
 * scheduled task. Work a linked environment started may not: none of it
 * carries the link's origin, so none of it is that link's.
 */
export const writes = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
  options?: {
    /** Whether a linked caller may make it, as for uploads its own sends need. */
    readonly linkedCallers?: "allowed";
  },
) =>
  declare(
    (params: P) =>
      orchestratingCaller.pipe(
        Effect.tap((caller) =>
          options?.linkedCallers === "allowed"
            ? Effect.void
            : assertNotLinked(caller, "change this environment's scheduled tasks"),
        ),
        Effect.flatMap(() => handle(params)),
      ),
    () => orchestratingCaller,
  );

/** Requires handler capability checks, not thread control; linked work is refused the same way. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare(
    (params: P) =>
      writingCaller.pipe(
        Effect.tap((caller) => assertNotLinked(caller, "start work here that is not its link's")),
        Effect.flatMap(() => handle(params)),
      ),
    () => writingCaller,
  );

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        for (const threadId of threads(params)) {
          if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
          const target = yield* caller.threads
            .getThreadShell(threadId)
            .pipe(Effect.mapError(unavailable));
          if (target !== null && target.deletedAt === null) {
            yield* assertExternalWorkOwner(caller.scope, target);
            if (target.agentTask?.externalOwner !== undefined)
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "Use the owned task lifecycle instead of modifying its backing thread.",
              });
            yield* assertTargetWithinLimits(caller.limits, target);
            yield* assertSameLink(caller, target);
          }
        }
        // Modes can rise after this check; the orchestrator rechecks under lock and records refusal before handlers wrap errors.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        return yield* handle(params).pipe(
          Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail<E | OrchestratorMcpFailure>(
                refusal === undefined ? error : escalationDenied(refusal),
              ),
            ),
          ),
        );
      }),
    () => writingCaller,
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The linked environment the caller acts for. The thread must carry it. */
  readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
}

/**
 * Starts threads with the modes `modes` requests, which may not be broader
 * than the caller's. `linked` says what a linked caller gets: threads stamped
 * with its `linkOrigin`, or a refusal where the tool cannot carry one.
 */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
  linked: "stamped" | { readonly refused: string },
) => {
  const started = Effect.fn("McpToolAccess.started")(function* (caller: Caller, params: P) {
    const requested = modes(params);
    return {
      runtimeMode: yield* resolveRuntimeMode(caller.limits.runtimeMode, requested.runtimeMode),
      interactionMode: yield* resolveInteractionMode(
        caller.limits.interactionMode,
        requested.interactionMode,
      ),
      linkOrigin: callerLinkOrigin(caller),
    } satisfies StartedModes;
  });
  return declare(
    (params: P) =>
      Effect.gen(function* () {
        const caller = yield* writingCaller;
        if (linked !== "stamped") yield* assertNotLinked(caller, linked.refused);
        return yield* handle(params, yield* started(caller, params));
      }),
    (params: P) => Effect.flatMap(writingCaller, (caller) => started(caller, params)),
  );
};

/** One tool with two access rules, picked per call, such as create versus update. */
export const either = <P, A, E, R, A2, E2, R2>(
  useFirst: (params: P) => boolean,
  first: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  second: Declaration<(params: P) => Effect.Effect<A2, E2, R2>>,
) => {
  const remotes = [remoteCheckOf(first), remoteCheckOf(second)] as ReadonlyArray<
    RemoteCheck<P> | undefined
  >;
  return declare(
    (params: P): Effect.Effect<A | A2, E | E2, R | R2> =>
      useFirst(params) ? checkedHandler(first)(params) : checkedHandler(second)(params),
    (params) =>
      remotes[useFirst(params) ? 0 : 1]?.(params) ??
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This action acts as the calling thread, which is here. Omit environmentId.",
        }),
      ),
  );
};

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
  options?: {
    /**
     * Whether a linked caller may make it, as for adding a project: it leaves
     * everything already here as it was.
     */
    readonly linkedCallers?: "allowed";
  },
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) =>
      options?.linkedCallers === "allowed"
        ? Effect.void
        : assertNotLinked(caller, "change projects or environment settings"),
    ),
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare(
    (params: P) => check.pipe(Effect.flatMap(() => handle(params, check))),
    // Linked work never reaches a link at all; that is checked as the call goes.
    () =>
      orchestratingCaller.pipe(
        Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
      ),
  );
};

/** Who records a contributed learning: a thread here, or a link passing one on. */
export type Contributor =
  | { readonly kind: "thread"; readonly caller: Caller }
  | { readonly kind: "link"; readonly sessionId: string; readonly label: string };

/**
 * A learning contributed to a Champion: by an orchestrating thread here, which
 * may pass it on to a linked environment itself, or by a linked environment
 * passing one on for a thread it authenticated. Managed workers are refused
 * where they run, so no link carries one.
 */
export const contributes = <P, A, E, R>(
  handle: (params: P, from: Contributor) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          scope.thread === undefined && scope.client?.linked === true
            ? handle(params, {
                kind: "link",
                sessionId: scope.client.sessionId,
                label: scope.client.label,
              })
            : requireThreadCaller.pipe(
                Effect.andThen(orchestratingCaller),
                Effect.flatMap((caller) => handle(params, { kind: "thread", caller })),
              ),
        ),
      ),
    undefined,
  );

/**
 * Away is one of the two writes a linked environment may make here (`contributes` is the other): its link already reads every thread,
 * and it lets the person set Away on each machine from an agent on another.
 */
export const setsAway = <P, A, E, R>(
  handle: (params: P, fromPeer: boolean) => Effect.Effect<A, E, R>,
) =>
  declare(
    (params: P) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          scope.client?.access === "peer-threads"
            ? handle(params, true)
            : orchestratingCaller.pipe(
                Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
                Effect.flatMap(() => handle(params, false)),
              ),
        ),
      ),
    undefined,
  );

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

/**
 * The only tools a linked environment may call: thread and Champion reads, Away (`setsAway`)
 * and passing on a contributed learning (`contributes`). Every other tool refuses it before
 * running, so a tool added later is closed to peers until listed here.
 */
const PEER_THREAD_TOOLS: ReadonlySet<string> = new Set([
  "t3_fleet_summary",
  "t3_thread_list",
  "t3_thread_search",
  "t3_thread_read",
  "t3_environment_read",
  "t3_environment_set_away",
  "t3_champions_list",
  "t3_champions_get",
  "t3_champions_learning_search",
  "t3_champions_learning_topics",
  "t3_champions_learning_read",
  "t3_champions_contribute_learning",
]);

const refusePeerClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "peer-threads"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "A linked environment may only read threads and Champion learnings, and contribute learnings.",
          }),
        )
      : Effect.void,
  ),
);

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Object.fromEntries(
    Object.entries(declarations as Record<string, Declaration<(params: never) => unknown>>).map(
      ([name, declaration]) => {
        const handle = checkedHandler(declaration);
        return [
          name,
          PEER_THREAD_TOOLS.has(name)
            ? handle
            : (params: never) =>
                refusePeerClient.pipe(Effect.andThen(handle(params) as Effect.Effect<unknown>)),
        ];
      },
    ),
  ) as Handlers;

/**
 * A tool runs in a linked environment when its parameters take this target
 * as `environmentId`. Other tools may name an environment for their own
 * reasons, such as the one to link or to move a thread to.
 */
const takesLinkedEnvironment = (tool: Tool.Any) => {
  const parameters: unknown = tool.parametersSchema;
  return (
    Predicate.hasProperty(parameters, "fields") &&
    Predicate.hasProperty(parameters.fields, "environmentId") &&
    parameters.fields.environmentId === OrchestratorMcpEnvironmentTarget
  );
};

const linksUnavailable = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "This environment cannot reach linked environments.",
});

/**
 * Every tool that takes a linked environment runs there the same way: its
 * declaration checks the caller here, and the same call goes to the other
 * environment, which checks the rest. The handler here never sees
 * `environmentId`, so it cannot leak into what it writes.
 */
const routed = Effect.fn("McpToolAccess.routed")(function* <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  declarations: Handlers<Tools>,
  checked: Toolkit.HandlersFrom<Tools>,
) {
  // Optional so toolkits that never leave this environment build without it.
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const handlers: Record<string, unknown> = { ...checked };
  for (const [name, declaration] of Object.entries<Declaration<unknown>>(declarations)) {
    const tool = toolkit.tools[name];
    if (tool === undefined || !takesLinkedEnvironment(tool)) continue;
    const remote = remoteCheckOf(declaration);
    if (remote === undefined)
      return yield* Effect.die(
        `${name} takes a linked environment, but it acts as its calling thread, which is here.`,
      );
    const here = handlers[name] as (
      params: object,
    ) => Effect.Effect<unknown, Tool.Failure<Tools[keyof Tools]>>;
    handlers[name] = ({ environmentId, ...params }: { readonly environmentId?: EnvironmentId }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const target = PeerForwarding.remoteTarget(scope, environmentId);
        if (target === undefined) return yield* here(params);
        if (scope.linkedEnvironments === false) return yield* PeerForwarding.linkedEnvironmentsOff;
        yield* (remote as RemoteCheck<typeof params>)(params);
        if (Option.isNone(forwarding)) return yield* linksUnavailable;
        return yield* forwarding.value.call(scope, tool, target, { ...params, environmentId });
      });
  }
  return handlers as Toolkit.HandlersFrom<Tools>;
});

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> => {
  // Checked as soon as they are given, so a forged declaration fails here.
  const withDeclarations = (declarations: Handlers<Tools>) =>
    routed(toolkit, declarations, checkedHandlers(declarations));
  return handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build) ? Effect.flatMap(build, withDeclarations) : withDeclarations(build),
    ),
  );
};
