// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Settings → Accounts for Pi (fork/differences.md `pi-accounts`): each Pi model credential
 * as its own account, read and written in the Pi instance's own agent directory. Every change
 * refreshes that instance, so its catalog and usage slots, and every Pi launched after it,
 * see the change; turns already running finish on what they started with.
 */
import {
  PiAccountsError,
  type PiAccountFamily,
  type PiAccountLoginFlowInput,
  type PiAccountLoginRespondInput,
  type PiAccountLoginStartInput,
  type PiAccountLoginState,
  type PiAccountRemoveInput,
  type PiAccountSaveKeyInput,
  type PiAccountsInput,
  type PiAccountsSeparateInput,
  type PiAccountsState,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  abandonPiAccount,
  installPiAccountsExtension,
  listPiAccounts,
  movePiSettingsProvider,
  parsePiLoginEvent,
  PI_ACCOUNT_LOGIN_SCRIPT,
  PI_LOGIN_PROVIDER_ENV,
  PI_LOGIN_SDK_ENV,
  piAgentDirectory,
  preparePiAccount,
  removePiAccount,
  resolvePiSdkEntry,
  savePiAccountKey,
  separatePiSharedLogins,
  type PiLoginEvent,
} from "@t3tools/provider-pi/server/accounts";
import { PI_OAUTH_FAMILIES } from "@t3tools/shared/piAccounts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import { ServerSettingsService } from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/** A sign-in nobody finishes is abandoned, as Pi's own callback listeners give up. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FINISHED_FLOW_RETENTION_MS = 5 * 60_000;
const TERMINAL: ReadonlySet<PiAccountLoginState["phase"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export class PiAccountsService extends Context.Service<
  PiAccountsService,
  {
    readonly list: (input: PiAccountsInput) => Effect.Effect<PiAccountsState, PiAccountsError>;
    readonly saveKey: (
      input: PiAccountSaveKeyInput,
    ) => Effect.Effect<PiAccountsState, PiAccountsError>;
    readonly remove: (
      input: PiAccountRemoveInput,
    ) => Effect.Effect<PiAccountsState, PiAccountsError>;
    readonly separate: (
      input: PiAccountsSeparateInput,
    ) => Effect.Effect<PiAccountsState, PiAccountsError>;
    readonly loginStart: (
      input: PiAccountLoginStartInput,
    ) => Effect.Effect<PiAccountLoginState, PiAccountsError>;
    readonly loginRespond: (
      input: PiAccountLoginRespondInput,
    ) => Effect.Effect<PiAccountLoginState, PiAccountsError>;
    readonly loginCancel: (
      input: PiAccountLoginFlowInput,
    ) => Effect.Effect<PiAccountLoginState, PiAccountsError>;
    readonly loginSubscribe: (
      input: PiAccountLoginFlowInput,
    ) => Stream.Stream<PiAccountLoginState, PiAccountsError>;
  }
>()("t3/provider/PiAccountsService") {}

const isPiAccountsError = Schema.is(PiAccountsError);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Moves T3's references to a retired Pi provider (`antigravity`) onto the account that took
 * over its login, for the Pi instances that served it. Model slugs `from/<model>` become
 * `to/<model>`; routed account IDs `<instance>:from` become `<instance>:to`.
 */
export function movedProviderReferences(
  settings: ServerSettings,
  instanceIds: ReadonlyArray<string>,
  from: string,
  to: string,
): ServerSettingsPatch {
  const slug = (value: string) =>
    value.startsWith(`${from}/`) ? `${to}/${value.slice(from.length + 1)}` : value;
  const accounts = new Map(instanceIds.map((id) => [`${id}:${from}`, `${id}:${to}`]));
  const account = (value: string) => accounts.get(value) ?? value;
  const deep = (value: unknown, rewrite: (text: string) => string): unknown =>
    typeof value === "string"
      ? rewrite(value)
      : Array.isArray(value)
        ? value.map((entry) => deep(entry, rewrite))
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [rewrite(key), deep(entry, rewrite)]),
            )
          : value;
  const patch: Record<string, unknown> = {};
  const favorites = settings.favorites ?? [];
  if (
    favorites.some(
      (favorite) =>
        instanceIds.includes(favorite.provider) && favorite.model !== slug(favorite.model),
    )
  ) {
    patch["favorites"] = favorites.map((favorite) =>
      instanceIds.includes(favorite.provider)
        ? { ...favorite, model: slug(favorite.model) }
        : favorite,
    );
  }
  const preferences = settings.providerModelPreferences ?? {};
  const movedPreferences = Object.fromEntries(
    Object.entries(preferences).map(([id, value]) => [
      id,
      instanceIds.includes(id) ? deep(value, slug) : value,
    ]),
  );
  if (JSON.stringify(movedPreferences) !== JSON.stringify(preferences)) {
    patch["providerModelPreferences"] = movedPreferences;
  }
  // Reserves are keyed by account and merge per key, so the old key is removed.
  const reserves = Object.entries(settings.accountReserves ?? {}).flatMap(([id, reserve]) =>
    account(id) === id ? [] : [[id, null] as const, [account(id), reserve] as const],
  );
  if (reserves.length > 0) patch["accountReserves"] = Object.fromEntries(reserves);
  // Routes name accounts in their tiers.
  for (const field of ["modelAccounts", "modelRouting"] as const) {
    const moved = Object.fromEntries(
      Object.entries(settings[field] ?? {}).flatMap(([key, value]) => {
        const next = deep(value, account);
        return JSON.stringify(next) === JSON.stringify(value) ? [] : [[key, next]];
      }),
    );
    if (Object.keys(moved).length > 0) patch[field] = moved;
  }
  return patch as ServerSettingsPatch;
}

interface LoginFlow {
  readonly instanceId: ProviderInstanceId;
  readonly agentDir: string;
  readonly providerId: string;
  readonly created: boolean;
  readonly state: SubscriptionRef.SubscriptionRef<PiAccountLoginState>;
  readonly send: (message: Record<string, unknown>) => void;
  readonly kill: () => void;
}

const makePiAccountsService = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const flows = new Map<string, LoginFlow>();

  const fail = (instanceId: ProviderInstanceId, operation: string) => (detail: string) =>
    new PiAccountsError({ instanceId, operation, detail });

  const context = Effect.fn("PiAccounts.context")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    const credentials = instance?.piCredentials;
    const agentDir = credentials === undefined ? null : piAgentDirectory(credentials.environment);
    if (credentials === undefined || agentDir === null) {
      return yield* fail(
        instanceId,
        operation,
      )(
        instance === undefined
          ? "This Pi instance is no longer available."
          : "This provider is not Pi.",
      );
    }
    return { agentDir, ...credentials };
  });

  /** Credential changes keep their own safe wording; anything else says only that it failed. */
  const withSafeErrors =
    (instanceId: ProviderInstanceId, operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isPiAccountsError(error)
            ? error
            : new PiAccountsError({
                instanceId,
                operation,
                detail:
                  isRecord(error) &&
                  error["_tag"] === "PiAccountsFileError" &&
                  typeof error["detail"] === "string"
                    ? error["detail"]
                    : "T3 could not change Pi's credentials.",
                cause: error,
              }),
        ),
      );

  const state = Effect.fn("PiAccounts.state")(function* (
    instanceId: ProviderInstanceId,
    agentDir: string,
  ) {
    const listing = yield* listPiAccounts(agentDir);
    return {
      instanceId,
      accounts: listing.accounts,
      sharedLogins: listing.sharedLogins,
    } satisfies PiAccountsState;
  });

  const refresh = (instanceId: ProviderInstanceId) =>
    providers.refreshInstance(instanceId).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));

  /** Moves T3's and Pi's references off a provider a split retired. */
  const moveReferences = Effect.fn("PiAccounts.moveReferences")(function* (
    instanceId: ProviderInstanceId,
    agentDir: string,
    moved: { readonly from: string; readonly to: string } | undefined,
  ) {
    if (moved === undefined) return;
    yield* movePiSettingsProvider(agentDir, moved.from, moved.to);
    const current = yield* settings.getSettings;
    const patch = movedProviderReferences(current, [instanceId], moved.from, moved.to);
    if (Object.keys(patch).length > 0) yield* settings.updateSettings(patch);
  });

  const separateFamily = Effect.fn("PiAccounts.separateFamily")(function* (
    instanceId: ProviderInstanceId,
    agentDir: string,
    family: PiAccountFamily,
  ) {
    if (family !== "antigravity" && family !== "commandcode") return;
    const listing = yield* listPiAccounts(agentDir);
    if (!listing.sharedLogins.some((shared) => shared.providerFamily === family)) return;
    yield* moveReferences(instanceId, agentDir, yield* separatePiSharedLogins(agentDir, family));
  });

  const list = Effect.fn("PiAccounts.list")(
    function* (input: PiAccountsInput) {
      const { agentDir } = yield* context(input.instanceId, "list");
      return yield* state(input.instanceId, agentDir).pipe(
        withSafeErrors(input.instanceId, "list"),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const saveKey = Effect.fn("PiAccounts.saveKey")(
    function* (input: PiAccountSaveKeyInput) {
      const { agentDir } = yield* context(input.instanceId, "saveKey");
      yield* Effect.gen(function* () {
        yield* separateFamily(input.instanceId, agentDir, input.providerFamily);
        yield* savePiAccountKey(agentDir, input);
        yield* installPiAccountsExtension(agentDir);
      }).pipe(withSafeErrors(input.instanceId, "saveKey"));
      yield* refresh(input.instanceId);
      return yield* state(input.instanceId, agentDir).pipe(
        withSafeErrors(input.instanceId, "saveKey"),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const remove = Effect.fn("PiAccounts.remove")(
    function* (input: PiAccountRemoveInput) {
      const { agentDir } = yield* context(input.instanceId, "remove");
      yield* removePiAccount(agentDir, input.providerId).pipe(
        withSafeErrors(input.instanceId, "remove"),
      );
      yield* refresh(input.instanceId);
      return yield* state(input.instanceId, agentDir).pipe(
        withSafeErrors(input.instanceId, "remove"),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const separate = Effect.fn("PiAccounts.separate")(
    function* (input: PiAccountsSeparateInput) {
      const { agentDir } = yield* context(input.instanceId, "separate");
      yield* Effect.gen(function* () {
        yield* separateFamily(input.instanceId, agentDir, input.providerFamily);
        yield* installPiAccountsExtension(agentDir);
      }).pipe(withSafeErrors(input.instanceId, "separate"));
      yield* refresh(input.instanceId);
      return yield* state(input.instanceId, agentDir).pipe(
        withSafeErrors(input.instanceId, "separate"),
      );
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const applyEvent = (flow: LoginFlow, event: PiLoginEvent) =>
    SubscriptionRef.update(flow.state, (current): PiAccountLoginState => {
      if (TERMINAL.has(current.phase)) return current;
      switch (event.type) {
        case "auth_url":
          return {
            ...current,
            phase: "waiting",
            authUrl: event.url,
            instructions: event.instructions,
          };
        case "device_code":
          return {
            ...current,
            phase: "waiting",
            deviceCode: { url: event.url, userCode: event.userCode },
          };
        case "prompt":
          return {
            ...current,
            phase: "waiting",
            message: null,
            prompt: {
              id: event.id,
              kind: event.kind,
              message: event.message.slice(0, 2_000),
              placeholder: event.placeholder?.slice(0, 500) ?? null,
              options: event.options.slice(0, 16),
            },
          };
        case "prompt_closed":
          return current.prompt?.id === event.id ? { ...current, prompt: null } : current;
        case "progress":
          return { ...current, message: event.message.slice(0, 2_000) || current.message };
        case "done":
          return { ...current, phase: "succeeded", prompt: null, message: "Signed in." };
        case "cancelled":
          return { ...current, phase: "cancelled", prompt: null, message: "Sign-in cancelled." };
        case "error":
          return {
            ...current,
            phase: "failed",
            prompt: null,
            message: event.message.slice(0, 2_000),
          };
      }
    });

  /** After the sign-in ends: keep the account it signed in, else drop the one it listed. */
  const settle = Effect.fn("PiAccounts.settleLogin")(
    function* (flowId: string, flow: LoginFlow) {
      const finished = yield* SubscriptionRef.get(flow.state);
      if (!TERMINAL.has(finished.phase)) {
        yield* SubscriptionRef.update(flow.state, (current) => ({
          ...current,
          phase: "failed" as const,
          prompt: null,
          message: "Pi's sign-in stopped before it finished.",
        }));
      }
      const phase = (yield* SubscriptionRef.get(flow.state)).phase;
      if (phase !== "succeeded" && flow.created) {
        yield* abandonPiAccount(flow.agentDir, flow.providerId).pipe(
          Effect.ignoreCause({ log: true }),
        );
      }
      yield* refresh(flow.instanceId);
      yield* Effect.sleep(FINISHED_FLOW_RETENTION_MS);
      flows.delete(flowId);
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const loginStart = Effect.fn("PiAccounts.loginStart")(
    function* (input: PiAccountLoginStartInput) {
      const operation = "loginStart";
      const ctx = yield* context(input.instanceId, operation);
      if (!PI_OAUTH_FAMILIES.has(input.providerFamily)) {
        return yield* fail(
          input.instanceId,
          operation,
        )("This account takes a key; it has no sign-in.");
      }
      const sdkEntry = yield* resolvePiSdkEntry(ctx.binaryPath, ctx.environment);
      if (sdkEntry === undefined) {
        return yield* fail(
          input.instanceId,
          operation,
        )("T3 could not find the Pi install this instance runs.");
      }
      const prepared = yield* Effect.gen(function* () {
        yield* separateFamily(input.instanceId, ctx.agentDir, input.providerFamily);
        const result = yield* preparePiAccount(ctx.agentDir, input);
        yield* installPiAccountsExtension(ctx.agentDir);
        return result;
      }).pipe(withSafeErrors(input.instanceId, operation));
      for (const existing of flows.values()) {
        if (
          existing.instanceId === input.instanceId &&
          existing.providerId === prepared.providerId
        ) {
          const current = yield* SubscriptionRef.get(existing.state);
          if (!TERMINAL.has(current.phase)) existing.send({ type: "cancel" });
        }
      }
      const flowId = NodeCrypto.randomUUID();
      const initial: PiAccountLoginState = {
        flowId,
        instanceId: input.instanceId,
        providerId: prepared.providerId,
        phase: "starting",
        authUrl: null,
        instructions: null,
        deviceCode: null,
        prompt: null,
        message: null,
      };
      const stateRef = yield* SubscriptionRef.make(initial);
      const workDir = yield* fileSystem
        .makeTempDirectory({ prefix: "t3-pi-login-" })
        .pipe(Effect.orElseSucceed(() => NodeOS.tmpdir()));
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "--eval", PI_ACCOUNT_LOGIN_SCRIPT],
        {
          cwd: workDir,
          env: {
            ...ctx.environment,
            [PI_LOGIN_SDK_ENV]: sdkEntry,
            [PI_LOGIN_PROVIDER_ENV]: prepared.providerId,
            // Packaged desktop runs the server under Electron, which this flag makes act as Node.
            ELECTRON_RUN_AS_NODE: "1",
          },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const flow: LoginFlow = {
        instanceId: input.instanceId,
        agentDir: ctx.agentDir,
        providerId: prepared.providerId,
        created: prepared.created,
        state: stateRef,
        send: (message) => {
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        kill: () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        },
      };
      flows.set(flowId, flow);
      NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
        const event = parsePiLoginEvent(line);
        if (event !== undefined) runFork(applyEvent(flow, event));
      });
      const timeout = runFork(
        Effect.sleep(LOGIN_TIMEOUT_MS).pipe(
          Effect.andThen(Effect.sync(() => flow.send({ type: "cancel" }))),
        ),
      );
      child.on("error", () =>
        runFork(applyEvent(flow, { type: "error", message: "T3 could not start Pi's sign-in." })),
      );
      child.on("exit", () => {
        runFork(Fiber.interrupt(timeout));
        runFork(
          settle(flowId, flow).pipe(
            Effect.ensuring(fileSystem.remove(workDir, { recursive: true }).pipe(Effect.ignore)),
          ),
        );
      });
      return initial;
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const findFlow = Effect.fn("PiAccounts.findFlow")(function* (
    input: PiAccountLoginFlowInput,
    operation: string,
  ) {
    const flow = flows.get(input.flowId);
    if (flow === undefined || flow.instanceId !== input.instanceId) {
      return yield* fail(input.instanceId, operation)("This sign-in has ended. Start it again.");
    }
    return flow;
  });

  const loginRespond = Effect.fn("PiAccounts.loginRespond")(function* (
    input: PiAccountLoginRespondInput,
  ) {
    const flow = yield* findFlow(input, "loginRespond");
    const current = yield* SubscriptionRef.get(flow.state);
    if (current.prompt?.id !== input.promptId) {
      return yield* fail(input.instanceId, "loginRespond")("That question was already answered.");
    }
    flow.send({ type: "answer", id: input.promptId, value: input.value });
    return yield* SubscriptionRef.updateAndGet(flow.state, (state) => ({
      ...state,
      prompt: null,
      message: "Checking…",
    }));
  });

  const loginCancel = Effect.fn("PiAccounts.loginCancel")(function* (
    input: PiAccountLoginFlowInput,
  ) {
    const flow = yield* findFlow(input, "loginCancel");
    flow.send({ type: "cancel" });
    // A flow that ignores the request still stops: its process goes after a short grace.
    runFork(Effect.sleep(5_000).pipe(Effect.andThen(Effect.sync(flow.kill))));
    return yield* SubscriptionRef.get(flow.state);
  });

  const loginSubscribe = (input: PiAccountLoginFlowInput) =>
    Stream.unwrap(
      Effect.map(findFlow(input, "loginSubscribe"), (flow) =>
        SubscriptionRef.changes(flow.state).pipe(
          Stream.takeUntil((state) => TERMINAL.has(state.phase)),
        ),
      ),
    );

  return PiAccountsService.of({
    list,
    saveKey,
    remove,
    separate,
    loginStart,
    loginRespond,
    loginCancel,
    loginSubscribe,
  });
});

export const layer = Layer.effect(PiAccountsService, makePiAccountsService);
