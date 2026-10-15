import {
  PreviewAutomationBackendError,
  PreviewAutomationOpenInput,
  type PreviewAutomationStatus,
  PreviewAutomationSnapshot,
  PreviewTabId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PhiBrowserRunner from "./PhiBrowserRunner.ts";
import {
  PHI_OPERATIONS,
  PhiBrowserInputError,
  translatePhiOperation,
} from "./PhiBrowserProtocol.ts";

const Binding = Schema.Struct({
  tabId: PreviewTabId,
  environmentId: Schema.String,
  threadId: Schema.String,
  sessionId: Schema.String,
  lane: Schema.Literals(["shadow", "agents"]),
  name: Schema.String,
  skillDirectory: Schema.String,
  profile: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.Number),
  targetId: Schema.optional(Schema.String),
  url: Schema.String,
  title: Schema.String,
});
type Binding = typeof Binding.Type;
const Journal = Schema.fromJsonString(Schema.Array(Binding));
const decodeJournal = Schema.decodeUnknownEffect(Journal);
const encodeJournal = Schema.encodeEffect(Journal);
const decodeOpen = Schema.decodeUnknownEffect(PreviewAutomationOpenInput);
const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const BackendStatus = Schema.Struct({
  context: Schema.Struct({ windowId: Schema.Number }),
  tabs: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      url: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  space: Schema.optional(Schema.Struct({ ownership: Schema.String })),
  humanMessages: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))),
});
const decodeStatus = Schema.decodeUnknownEffect(BackendStatus);
const OpenedTab = Schema.Struct({ targetId: Schema.String });
const decodeOpened = Schema.decodeUnknownEffect(OpenedTab);
const WindowContext = Schema.Struct({ windowId: Schema.Number });
const decodeWindow = Schema.decodeUnknownEffect(WindowContext);
const ObservedSnapshot = Schema.Struct({
  text: Schema.String,
  observed: Schema.Struct({
    url: Schema.String,
    title: Schema.String,
    elements: Schema.Array(
      Schema.Struct({
        ref: Schema.NullOr(Schema.Number),
        role: Schema.String,
        name: Schema.optional(Schema.String),
      }),
    ),
  }),
  screenshot: PreviewAutomationSnapshot.fields.screenshot,
});
const decodeObserved = Schema.decodeUnknownEffect(ObservedSnapshot);

const isInputError = Schema.is(PhiBrowserInputError);
const isRunnerError = Schema.is(PhiBrowserRunner.PhiBrowserRunnerError);
const isBackendError = Schema.is(PreviewAutomationBackendError);
const failure = (reason: PreviewAutomationBackendError["reason"], cause?: unknown) => {
  if (isBackendError(cause)) return cause;
  if (
    isInputError(cause) &&
    (cause.reason === "stale-reference" || cause.reason === "unavailable-route")
  )
    reason = cause.reason;
  if (
    isRunnerError(cause) &&
    (cause.reason === "missing-skill" || cause.reason === "invalid-response")
  )
    reason = cause.reason;
  return new PreviewAutomationBackendError({
    backend: "phi",
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
};

export const isPhiTabId = (tabId: PreviewTabId) => tabId.startsWith("phi-");

const owns = (binding: Binding, scope: McpThreadInvocationScope) =>
  binding.environmentId === scope.environmentId &&
  binding.threadId === scope.thread.threadId &&
  binding.sessionId === scope.thread.providerSessionId;

export class PhiBrowser extends Context.Service<
  PhiBrowser,
  {
    readonly hasTab: (tabId: PreviewTabId) => Effect.Effect<boolean>;
    readonly invoke: (
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<unknown, PreviewAutomationBackendError>;
    readonly list: (
      scope: McpThreadInvocationScope,
    ) => Effect.Effect<ReadonlyArray<PreviewSessionSnapshot>>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
  }
>()("t3/preview/PhiBrowser") {}

const make = Effect.gen(function* () {
  const runner = yield* PhiBrowserRunner.PhiBrowserRunner;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const journalPath = path.join(config.stateDir, "phi-browser-tabs.json");
  const loaded = yield* Effect.gen(function* () {
    const tabs = (yield* fs.exists(journalPath))
      ? yield* fs.readFileString(journalPath).pipe(Effect.flatMap(decodeJournal))
      : [];
    return { healthy: true, tabs };
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read Phi ownership journal", { cause }).pipe(
        Effect.as({ healthy: false, tabs: [] as ReadonlyArray<Binding> }),
      ),
    ),
  );
  const state = yield* Ref.make(loaded.tabs);
  const retired = new Set(loaded.tabs.map((tab) => tab.sessionId));
  const lock = yield* Semaphore.make(1);
  // References never survive a server restart or a new snapshot.
  const references = new Map<string, ReadonlyMap<string, string>>();
  const currentTabs = new Map<string, PreviewTabId>();
  const save = Effect.fn("PhiBrowser.save")(function* (tabs: ReadonlyArray<Binding>) {
    const contents = yield* encodeJournal(tabs).pipe(
      Effect.mapError((cause) => failure("storage", cause)),
    );
    yield* writeFileStringAtomically({ filePath: journalPath, contents }).pipe(
      Effect.mapError((cause) => failure("storage", cause)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* Ref.set(state, tabs);
  });
  const context = (binding: Binding): PhiBrowserRunner.PhiBrowserRound["context"] =>
    binding.lane === "agents"
      ? { kind: "agent", name: "Agents", persistent: true }
      : {
          kind: "shadow",
          name: binding.name,
          incognito: true,
          ...(binding.profile === undefined ? {} : { profile: binding.profile }),
        };
  const run = (
    binding: Binding,
    action: PhiBrowserRunner.PhiBrowserRound["action"],
    timeoutMs = 15_000,
    readHumanMessages = false,
  ) =>
    runner
      .run({
        context: context(binding),
        skillDirectory: binding.skillDirectory,
        ...(binding.windowId === undefined ? {} : { expectedWindow: binding.windowId }),
        ...(binding.targetId === undefined ? {} : { targetId: binding.targetId }),
        action,
        timeoutMs,
        readHumanMessages,
      })
      .pipe(Effect.mapError((cause) => failure("unavailable", cause)));
  const remove = (binding: Binding) =>
    Effect.gen(function* () {
      yield* run(binding, { operation: "close" });
      yield* save((yield* Ref.get(state)).filter((tab) => tab.tabId !== binding.tabId));
      references.delete(binding.tabId);
      if (currentTabs.get(binding.sessionId) === binding.tabId)
        currentTabs.delete(binding.sessionId);
    });
  const status = (binding: Binding, connected = true): PreviewAutomationStatus => ({
    backend: "phi",
    connected,
    supportedOperations: PHI_OPERATIONS,
    phiLane: binding.lane,
    available: connected,
    visible: false,
    tabId: binding.tabId,
    url: binding.url || null,
    title: binding.title || null,
    loading: false,
    control: { owner: "agent", ownedByCaller: true, generation: 0 },
  });

  const invoke = Effect.fn("PhiBrowser.invoke")((request: PreviewAutomationInvokeInput) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!loaded.healthy) return yield* failure("storage");
        if (!request.scope.capabilities.has("preview")) return yield* failure("disabled");
        if (!PHI_OPERATIONS.some((operation) => operation === request.operation))
          return yield* failure("unsupported");
        let tabs = yield* Ref.get(state);
        let binding =
          request.tabId === undefined
            ? (tabs.find(
                (tab) =>
                  tab.tabId === currentTabs.get(request.scope.thread.providerSessionId) &&
                  owns(tab, request.scope),
              ) ?? tabs.findLast((tab) => owns(tab, request.scope)))
            : tabs.find((tab) => tab.tabId === request.tabId);
        const canRecover =
          binding &&
          retired.has(binding.sessionId) &&
          binding.environmentId === request.scope.environmentId &&
          binding.threadId === request.scope.thread.threadId &&
          binding.lane === "agents";
        if (
          request.tabId !== undefined &&
          (!binding || !owns(binding, request.scope)) &&
          !(canRecover && ["status", "resume"].includes(request.operation))
        )
          return yield* failure("ownership");
        if (binding && (binding.targetId === undefined || binding.windowId === undefined)) {
          if (request.operation === "status") {
            const { control: _control, ...disconnected } = status(binding, false);
            return {
              ...disconnected,
              connectionMessage:
                "Phi allocation did not finish. Close or recover the owned resource before continuing.",
            };
          }
          if (request.operation === "open" && binding.lane === "shadow") {
            yield* remove(binding);
            tabs = yield* Ref.get(state);
            binding = undefined;
          } else if (!(request.operation === "close" && binding.lane === "shadow"))
            return yield* failure("unavailable");
        }
        if (request.operation === "open") {
          const input = yield* decodeOpen(request.input).pipe(
            Effect.mapError((cause) => failure("unsupported", cause)),
          );
          if (input.reuseExistingTab === false) binding = undefined;
          if (
            binding &&
            ((input.phiLane !== undefined && input.phiLane !== binding.lane) ||
              (input.profileId !== undefined && input.profileId !== binding.profile))
          )
            return yield* failure("conflicting-binding");
          if (!binding) {
            const lane = input.phiLane ?? "shadow";
            if (lane === "agents" && input.profileId !== undefined)
              return yield* failure("unsupported");
            if (lane === "agents") {
              const previous = tabs.find((tab) => tab.lane === "agents");
              if (previous && retired.has(previous.sessionId)) {
                yield* remove(previous).pipe(
                  Effect.mapError((cause) => failure("human-control", cause)),
                );
                tabs = yield* Ref.get(state);
              }
              if (tabs.some((tab) => tab.lane === "agents")) return yield* failure("human-control");
            }
            const tabId = PreviewTabId.make(
              `phi-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
            );
            binding = {
              tabId,
              environmentId: request.scope.environmentId,
              threadId: request.scope.thread.threadId,
              sessionId: request.scope.thread.providerSessionId,
              lane,
              name: `t3-${tabId}`,
              skillDirectory: request.scope.phiBrowserSkillDirectory ?? "",
              url: input.url ?? "",
              title: "",
              ...(input.profileId === undefined ? {} : { profile: input.profileId }),
            };
            // Ownership exists on disk before Phi can allocate anything.
            yield* save([...tabs, binding]);
            const allocated = binding;
            yield* Effect.gen(function* () {
              const action = yield* Effect.try({
                try: () => translatePhiOperation("open", input, new Map(), platform !== "darwin"),
                catch: (cause) => failure("unsupported", cause),
              });
              const opened = yield* run(allocated, action, request.timeoutMs ?? 15_000);
              const tab = yield* decodeOpened(opened.result).pipe(
                Effect.mapError((cause) => failure("invalid-response", cause)),
              );
              const window = yield* decodeWindow(opened.context).pipe(
                Effect.mapError((cause) => failure("invalid-response", cause)),
              );
              binding = {
                ...allocated,
                url: action.url ?? allocated.url,
                targetId: tab.targetId,
                windowId: window.windowId,
              };
              yield* save(
                (yield* Ref.get(state)).map((entry) =>
                  entry.tabId === allocated.tabId ? binding! : entry,
                ),
              );
            }).pipe(
              Effect.onError(() =>
                allocated.lane === "shadow"
                  ? remove(allocated).pipe(Effect.ignore({ log: true }))
                  : Effect.void,
              ),
            );
          } else if (input.url !== undefined) {
            const action = yield* Effect.try({
              try: () =>
                translatePhiOperation(
                  "navigate",
                  { url: input.url },
                  new Map(),
                  platform !== "darwin",
                ),
              catch: (cause) => failure("unsupported", cause),
            });
            yield* run(binding, action, request.timeoutMs);
            references.delete(binding.tabId);
            binding = { ...binding, url: input.url };
            yield* save(
              (yield* Ref.get(state)).map((entry) =>
                entry.tabId === binding!.tabId ? binding! : entry,
              ),
            );
          }
          const verified = yield* run(binding!, { operation: "status" });
          const live = yield* decodeStatus(verified.result).pipe(
            Effect.mapError((cause) => failure("invalid-response", cause)),
          );
          if (!live.tabs.some((tab) => tab.targetId === binding!.targetId))
            return yield* failure("unavailable");
          request.onTargetTab?.(binding!.tabId);
          if (request.updateCurrentTab !== false)
            currentTabs.set(request.scope.thread.providerSessionId, binding!.tabId);
          const human = live.space?.ownership === "user";
          if (human) references.delete(binding!.tabId);
          return {
            ...status(binding!),
            control: { owner: human ? "human" : "agent", ownedByCaller: !human, generation: 0 },
          };
        }
        if (!binding) {
          if (request.operation === "status")
            return {
              backend: "phi",
              connected: false,
              available: false,
              supportedOperations: PHI_OPERATIONS,
              visible: false,
              loading: false,
              tabId: null,
              url: null,
              title: null,
            };
          return yield* failure("ownership");
        }
        request.onTargetTab?.(binding.tabId);
        const resolvedTabId = binding.tabId;
        const setCurrent = () => {
          if (request.updateCurrentTab !== false)
            currentTabs.set(request.scope.thread.providerSessionId, resolvedTabId);
        };
        if (request.operation === "close") {
          yield* remove(binding);
          return { tabId: null };
        }
        const action = yield* Effect.try({
          try: () =>
            translatePhiOperation(
              request.operation,
              request.input,
              references.get(binding!.tabId) ?? new Map(),
              platform !== "darwin",
            ),
          catch: (cause) => failure("unsupported", cause),
        });
        const executed = yield* run(
          binding,
          action,
          request.timeoutMs,
          request.operation === "status" && request.updateCurrentTab !== false,
        ).pipe(Effect.result);
        if (Result.isFailure(executed)) {
          if (request.operation !== "status") return yield* executed.failure;
          const { control: _control, ...disconnected } = status(binding, false);
          return { ...disconnected, connectionMessage: executed.failure.message };
        }
        const response = executed.success;
        if (request.operation === "status") {
          const result = yield* decodeStatus(response.result).pipe(
            Effect.mapError((cause) => failure("invalid-response", cause)),
          );
          const tab = result.tabs.find((tab) => tab.targetId === binding!.targetId);
          const human = result.space?.ownership === "user";
          if (human) references.delete(binding.tabId);
          setCurrent();
          return {
            humanMessages: result.humanMessages?.map((message) => message.text) ?? [],
            ...status(
              { ...binding, url: tab?.url ?? binding.url, title: tab?.title ?? binding.title },
              tab !== undefined,
            ),
            control: { owner: human ? "human" : "agent", ownedByCaller: !human, generation: 0 },
          };
        }
        if (request.operation === "snapshot") {
          const result = yield* decodeObserved(response.result).pipe(
            Effect.mapError((cause) => failure("invalid-response", cause)),
          );
          const generation = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const refs = new Map<string, string>();
          const names = new Map<string, string>();
          const elements = result.observed.elements.flatMap((element, index) => {
            if (element.ref === null) return [];
            const ref = `${binding!.tabId}-${generation}-${index}`;
            refs.set(ref, `@${element.ref}`);
            names.set(String(element.ref), ref);
            return [
              {
                tag: element.role,
                role: element.role,
                name: element.name ?? "",
                selector: `aria-ref=${ref}`,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
              },
            ];
          });
          references.set(binding.tabId, refs);
          setCurrent();
          return yield* decodeSnapshot({
            url: result.observed.url,
            title: result.observed.title,
            loading: false,
            visibleText: result.text.replace(/\bref=(\d+)\b/g, (_match, id: string) =>
              names.has(id) ? `aria-ref=${names.get(id)}` : "[unavailable-ref]",
            ),
            interactiveElements: elements,
            accessibilityTree: elements,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
            screenshot: result.screenshot,
          }).pipe(Effect.mapError((cause) => failure("invalid-response", cause)));
        }
        if (request.operation === "resume") {
          if (binding.lane !== "agents") return yield* failure("unsupported");
          const tabId = binding.tabId;
          yield* save(
            (yield* Ref.get(state)).map((tab) =>
              tab.tabId === tabId
                ? { ...tab, sessionId: request.scope.thread.providerSessionId }
                : tab,
            ),
          );
          retired.delete(binding.sessionId);
        }
        if (["navigate", "handoff", "resume"].includes(request.operation))
          references.delete(binding.tabId);
        setCurrent();
        return request.operation === "navigate"
          ? status({ ...binding, url: action.url ?? binding.url })
          : { tabId: binding.tabId };
      }),
    ),
  );

  const service = PhiBrowser.of({
    invoke,
    hasTab: (tabId) =>
      Ref.get(state).pipe(Effect.map((tabs) => tabs.some((tab) => tab.tabId === tabId))),
    list: (scope) =>
      Ref.get(state).pipe(
        Effect.map((tabs) =>
          tabs
            .filter(
              (tab) =>
                owns(tab, scope) ||
                (retired.has(tab.sessionId) &&
                  tab.lane === "agents" &&
                  tab.threadId === scope.thread.threadId &&
                  tab.environmentId === scope.environmentId),
            )
            .map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              backend: "phi",
              navStatus: { _tag: "Idle" as const },
              canGoBack: false,
              canGoForward: false,
              automationOwner: tab.sessionId,
              updatedAt: "1970-01-01T00:00:00.000Z",
            })),
        ),
      ),
    releaseSession: (sessionId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          retired.add(sessionId);
          const tabs = (yield* Ref.get(state)).filter((tab) => tab.sessionId === sessionId);
          yield* Effect.forEach(tabs, (tab) => remove(tab).pipe(Effect.ignore({ log: true })), {
            discard: true,
          });
        }),
      ),
  });
  // Reconcile resources recorded by the previous process. A human-controlled
  // Agents tab refuses close and keeps its custody record for explicit resume.
  for (const sessionId of retired) yield* service.releaseSession(sessionId);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = new Set((yield* Ref.get(state)).map((tab) => tab.sessionId));
      yield* Effect.forEach(sessions, (id) => service.releaseSession(id), { discard: true });
    }),
  );
  return service;
});

export const layer = Layer.effect(PhiBrowser, make);
