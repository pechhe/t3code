import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  assertManagedBrowserCaller,
  assertProjectBrowserAccess,
  drivesOwnBrowser,
  listsBrowserFamily,
  PHI_ONLY_BROWSER_BACKENDS,
} from "./ManagedBrowserAccess.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
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
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

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
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
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
  caller?.agentTask === undefined
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
  declare((params: P) => handle(params));

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/**
 * The scope one preview action runs in. A browser or ui-verifier child drives Phi as its whole job,
 * so those operations are not leaf writes for it, and its own tab is Phi's whatever the project's
 * default backend is; a child whose listing carries no browser stays a leaf. Closing a tab skips
 * the settings check so cleanup survives revoked access.
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
    browserBackends: PHI_ONLY_BROWSER_BACKENDS,
  } satisfies McpInvocationContext.McpInvocationScope;
});

const previewCaller = (options: { readonly checkSettings: boolean }) =>
  refuseReadOnlyClient.pipe(
    Effect.andThen(loadCaller()),
    Effect.tap(assertLiveCaller),
    Effect.flatMap((caller) => previewActionScope(caller, options)),
  );

/**
 * A preview read on the caller's own browser. A browser or ui-verifier credential is pinned to Phi
 * here too, so a read cannot reserve the project's default integrated browser and strand the
 * child's later action. Reads keep exactly the permissiveness they had: no leaf refusal, no
 * liveness check and no settings check, so ordinary parents, read-only callers and generic
 * children read as before. Reads change nothing, and status/list still let a revoked child find
 * its owned tab to close.
 */
export const readsAsPreviewCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap((scope) =>
        Effect.provideService(
          handle(params),
          McpInvocationContext.McpInvocationContext,
          listsBrowserFamily(scope)
            ? { ...scope, browserBackends: PHI_ONLY_BROWSER_BACKENDS }
            : scope,
        ),
      ),
    ),
  );

/**
 * One action on the caller's own browser. Tab ownership is unchanged: the broker keys tabs to the
 * caller's own session and the backend refuses another session's tab. Only the operations Phi
 * supports use this declaration; raw page code, uploads, recordings and appearance changes stay
 * `actsAsCaller`.
 */
export const actsAsPreviewCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => previewCaller({ checkSettings: true })),
      Effect.flatMap((scope) =>
        Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
      ),
    ),
  );

/** Closing a tab stays possible after the project's browser access is revoked. */
export const cleansUpAsPreviewCaller = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => previewCaller({ checkSettings: false })),
      Effect.flatMap((scope) =>
        Effect.provideService(handle(params), McpInvocationContext.McpInvocationContext, scope),
      ),
    ),
  );

/**
 * A managed browser task's own tab tools, on the `/mcp/browser` endpoint only. The credential,
 * the task's Phi pin and the project's browser settings are checked on every call.
 */
export const asManagedBrowser = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    assertManagedBrowserCaller({ checkSettings: true }).pipe(
      Effect.tap(assertLiveCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** Closing a managed browser task's tab stays possible after its browser access is revoked. */
export const cleansUpAsManagedBrowser = <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    assertManagedBrowserCaller({ checkSettings: false }).pipe(
      Effect.tap(assertLiveCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** External clients read their owned tasks; T3 callers retain the existing live-run gate. */
export const readsTask = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
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
  );

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/** Requires handler capability checks, not thread control. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
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
}

export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

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
 * The only tools a linked environment may call: it reads threads and learns
 * the peer's identity and version, nothing else. Every other tool refuses it
 * before running, so a tool added later is closed to peers until listed here.
 */
const PEER_THREAD_TOOLS: ReadonlySet<string> = new Set([
  "t3_fleet_summary",
  "t3_thread_list",
  "t3_thread_search",
  "t3_thread_read",
  "t3_environment_read",
]);

const refusePeerClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "peer-threads"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A linked environment may only read threads.",
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

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
