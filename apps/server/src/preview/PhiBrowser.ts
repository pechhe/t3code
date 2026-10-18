import {
  PhiBrowserLane,
  PreviewAutomationBackendError,
  PreviewAutomationOpenInput,
  type PreviewAutomationStatus,
  PreviewAutomationSnapshot,
  PreviewTabId,
  type PreviewSessionSnapshot,
  PreviewRenderedViewportSize,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
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
  lane: PhiBrowserLane,
  name: Schema.String,
  /** A user-lane tab the user already had open: released, never closed. */
  attached: Schema.optional(Schema.Literal(true)),
  skillDirectory: Schema.String,
  profile: Schema.optional(Schema.String),
  windowId: Schema.optional(Schema.Number),
  targetId: Schema.optional(Schema.String),
  allocationUrl: Schema.optional(Schema.String),
  viewport: Schema.optional(PreviewViewportSetting),
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
const decodeRendered = Schema.decodeUnknownEffect(PreviewRenderedViewportSize);
const ObservedSnapshot = Schema.Struct({
  text: Schema.String,
  /** Hidden or zero-size elements the scan left out. */
  omitted: Schema.optional(Schema.Int),
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

const MAX_SNAPSHOT_NAME_CHARS = 120;

/**
 * Cuts the text inside each `[aria-ref=... ]` tag, never the line around it: several controls
 * can share a line, and a cut line would drop the later refs. One huge name, such as a dev
 * toolbar's, would otherwise crowd out the page it sits on. A tag's own locator can hold `]`,
 * so a tag runs to the last `]` before the next tag or the end of the line.
 */
export const capLongNames = (text: string) =>
  text.replace(/\[aria-ref=\S+ [^\n]*?(?=\[aria-ref=|\n|$)/g, (segment) => {
    const end = segment.lastIndexOf("]");
    const space = segment.indexOf(" ");
    if (end < 0 || end - space - 1 <= MAX_SNAPSHOT_NAME_CHARS) return segment;
    const ref = segment.slice(1, space);
    const body = segment.slice(space + 1, end);
    return `${segment.slice(0, space + 1)}${body.slice(0, MAX_SNAPSHOT_NAME_CHARS)}… +${body.length - MAX_SNAPSHOT_NAME_CHARS} chars; a preview_snapshot with locator=${ref} is not cut here${segment.slice(end)}`;
  });

const MAX_SNAPSHOT_TEXT_CHARS = 20_000;

/** The runner hands over the whole scan so names can be cut first; keep its envelope lines. */
const boundText = (text: string) => {
  if (text.length <= MAX_SNAPSHOT_TEXT_CHARS) return text;
  const lines = text.split("\n");
  return [
    lines[0],
    lines.slice(1, -1).join("\n").slice(0, MAX_SNAPSHOT_TEXT_CHARS),
    lines.at(-1),
  ].join("\n");
};

// First, because the transport bounds the text and cuts the end of a long page.
const withOmitted = (text: string, omitted: number | undefined) =>
  omitted ? `[${omitted} hidden or zero-size elements left out]\n${text}` : text;

const isInputError = Schema.is(PhiBrowserInputError);
const isRunnerError = Schema.is(PhiBrowserRunner.PhiBrowserRunnerError);
const isBackendError = Schema.is(PreviewAutomationBackendError);
const failure = (reason: PreviewAutomationBackendError["reason"], cause?: unknown) => {
  if (isBackendError(cause)) return cause;
  if (
    isInputError(cause) &&
    (cause.reason === "stale-reference" ||
      cause.reason === "unavailable-route" ||
      cause.reason === "unsupported-shortcut" ||
      cause.reason === "unsupported-option")
  )
    reason = cause.reason;
  if (
    isRunnerError(cause) &&
    (cause.reason === "missing-skill" ||
      cause.reason === "invalid-response" ||
      cause.reason === "human-control" ||
      cause.reason === "login-required" ||
      cause.reason === "action-failed" ||
      cause.reason === "user-space-unavailable")
  )
    reason = cause.reason;
  const unmet = isRunnerError(cause) ? cause.unmet : undefined;
  return new PreviewAutomationBackendError({
    backend: "phi",
    reason,
    ...(unmet === undefined ? {} : { unmet }),
    ...(cause === undefined ? {} : { cause }),
  });
};

export type PhiAvailability = "available" | "skill-missing" | "unreachable";

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
    /**
     * Whether managed browser tasks can start. Discovery accepts a recent answer; a task launch
     * passes `probe` to ask Phi now. Nothing is allocated either way.
     */
    readonly availability: (input: {
      readonly skillDirectory: string;
      readonly probe: boolean;
    }) => Effect.Effect<PhiAvailability>;
  }
>()("t3/preview/PhiBrowser") {}

const make = Effect.gen(function* () {
  const runner = yield* PhiBrowserRunner.PhiBrowserRunner;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  // Phi keeps each driver's agent tasks apart, and the Mac's own driver holds its Agents
  // Space, so a host reaching that Phi remotely keeps a shared Space of its own.
  const agentsSpace = platform === "darwin" ? "Agents" : "Agents (VPS)";
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
      ? { kind: "agent", name: agentsSpace, persistent: true }
      : binding.lane === "user"
        ? { kind: "user", ...(binding.windowId === undefined ? {} : { window: binding.windowId }) }
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
        ...(binding.targetId === undefined
          ? binding.attached
            ? { attachFocusedTab: true as const }
            : {}
          : { targetId: binding.targetId }),
        ...(binding.allocationUrl === undefined ? {} : { allocationUrl: binding.allocationUrl }),
        ...(binding.viewport === undefined ? {} : { viewport: binding.viewport }),
        action,
        timeoutMs,
        readHumanMessages,
      })
      .pipe(Effect.mapError((cause) => failure("unavailable", cause)));
  // Only the owning agent's explicit close removes a tab from the user's own Space, and only
  // one it opened there; a released session or a restart just forgets it.
  const remove = (binding: Binding, closeUserTab = false) =>
    Effect.gen(function* () {
      if (binding.lane !== "user" || (closeUserTab && !binding.attached))
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

  // Discovery reads a recent answer rather than probing Phi on every call. A failed probe is
  // kept only briefly: a busy machine can slow a healthy Phi past the deadline, and a long-lived
  // false "unreachable" sends every agent to the fallback route.
  const REACHABILITY_TTL_MS = 30_000;
  const UNREACHABLE_TTL_MS = 5_000;
  // Covers a cold runner start, the CDP connection and a shadow status round, which take
  // over two seconds on a loaded Mac.
  const PROBE_TIMEOUT_MS = 5_000;
  const reachability = yield* Ref.make<
    ReadonlyMap<string, { readonly value: PhiAvailability; readonly at: number }>
  >(new Map());
  const availability = (input: { readonly skillDirectory: string; readonly probe: boolean }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const known = (yield* Ref.get(reachability)).get(input.skillDirectory);
      if (
        !input.probe &&
        known !== undefined &&
        now - known.at < (known.value === "unreachable" ? UNREACHABLE_TTL_MS : REACHABILITY_TTL_MS)
      )
        return known.value;
      const value: PhiAvailability = yield* runner
        .run({
          probe: true,
          skillDirectory: input.skillDirectory,
          context: { kind: "shadow", name: "t3-probe", incognito: true },
          action: { operation: "status" },
          timeoutMs: PROBE_TIMEOUT_MS,
        })
        .pipe(
          Effect.as("available" as const),
          Effect.catch((cause) =>
            Effect.succeed(
              cause.reason === "missing-skill"
                ? ("skill-missing" as const)
                : ("unreachable" as const),
            ),
          ),
        );
      yield* Ref.update(reachability, (values) =>
        new Map(values).set(input.skillDirectory, { value, at: now }),
      );
      return value;
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
          if (
            request.operation === "open" &&
            (binding.lane !== "agents" || binding.allocationUrl !== undefined)
          ) {
            yield* remove(binding);
            tabs = yield* Ref.get(state);
            binding = undefined;
          } else if (
            !(
              request.operation === "close" &&
              (binding.lane !== "agents" || binding.allocationUrl !== undefined)
            )
          )
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
            if (lane !== "shadow" && input.profileId !== undefined)
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
              ...(lane === "agents" ? { allocationUrl: `about:blank#t3-${tabId}` } : {}),
              // Without a URL the user lane carries on in the tab the user has in front of them.
              ...(lane === "user" && input.url === undefined ? { attached: true as const } : {}),
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
              // A user-lane takeover can land on a tab another task already holds; one tab, one task.
              if (
                (yield* Ref.get(state)).some(
                  (entry) => entry.tabId !== allocated.tabId && entry.targetId === tab.targetId,
                )
              )
                return yield* failure("ownership");
              const window = yield* decodeWindow(opened.context).pipe(
                Effect.mapError((cause) => failure("invalid-response", cause)),
              );
              binding = {
                ...allocated,
                url: allocated.attached ? "" : (action.url ?? allocated.url),
                targetId: tab.targetId,
                windowId: window.windowId,
              };
              yield* save(
                (yield* Ref.get(state)).map((entry) =>
                  entry.tabId === allocated.tabId ? binding! : entry,
                ),
              );
              if (allocated.lane === "agents" && action.url !== "about:blank") {
                yield* run(
                  binding,
                  { operation: "navigate", url: action.url, timeout: 15 },
                  request.timeoutMs ?? 15_000,
                );
              }
            }).pipe(
              Effect.onError(() =>
                Ref.get(state).pipe(
                  Effect.flatMap((tabs) =>
                    remove(tabs.find((tab) => tab.tabId === allocated.tabId) ?? allocated),
                  ),
                  Effect.ignore({ log: true }),
                ),
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
          const liveTab = live.tabs.find((tab) => tab.targetId === binding!.targetId);
          if (!liveTab) return yield* failure("unavailable");
          request.onTargetTab?.(binding!.tabId);
          if (request.updateCurrentTab !== false)
            currentTabs.set(request.scope.thread.providerSessionId, binding!.tabId);
          const human = live.space?.ownership === "user";
          if (human) references.delete(binding!.tabId);
          return {
            ...status({
              ...binding!,
              url: liveTab.url ?? binding!.url,
              title: liveTab.title ?? binding!.title,
            }),
            control: { owner: human ? "human" : "agent", ownedByCaller: !human, generation: 0 },
          };
        }
        if (!binding) {
          if (request.operation === "status") {
            const connection = yield* availability({
              skillDirectory: request.scope.phiBrowserSkillDirectory ?? "",
              probe: false,
            });
            return {
              backend: "phi",
              connected: connection === "available",
              ...(connection === "available"
                ? {}
                : {
                    connectionMessage:
                      connection === "skill-missing"
                        ? "Phi's installed skill runner is missing. Check its configured directory."
                        : "Phi is unreachable through the configured skill and Mac route.",
                  }),
              available: connection === "available",
              supportedOperations: PHI_OPERATIONS,
              visible: false,
              loading: false,
              tabId: null,
              url: null,
              title: null,
            };
          }
          return yield* failure("ownership");
        }
        request.onTargetTab?.(binding.tabId);
        const resolvedTabId = binding.tabId;
        const setCurrent = () => {
          if (request.updateCurrentTab !== false)
            currentTabs.set(request.scope.thread.providerSessionId, resolvedTabId);
        };
        if (request.operation === "close") {
          yield* remove(binding, true);
          return { tabId: null };
        }
        // The user's window is theirs to size, and they are already in control of it.
        if (binding.lane === "user" && ["resize", "handoff", "resume"].includes(request.operation))
          return yield* failure("unsupported");
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
          // Refs resolve only through this tab's map, which each snapshot replaces, so a short
          // random token per snapshot is enough to make another tab's or snapshot's ref fail.
          // Long refs would crowd page text out of the bounded snapshot response.
          const generation = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
          const refs = new Map<string, string>();
          const names = new Map<string, string>();
          result.observed.elements.forEach((element, index) => {
            if (element.ref === null) return;
            const ref = `${generation}-${index}`;
            refs.set(ref, `@${element.ref}`);
            names.set(String(element.ref), ref);
          });
          references.set(binding.tabId, refs);
          setCurrent();
          const text = result.text.replace(/\bref=(\d+)\b/g, (_match, id: string) =>
            names.has(id) ? `aria-ref=${names.get(id)}` : "[unavailable-ref]",
          );
          // A scoped snapshot is how an agent reads a capped name in full.
          const scoped = action.target !== undefined;
          // visibleText already lists every element once, tagged with its ref. Repeating them in
          // interactiveElements, with no geometry to add, only doubles what an agent has to read.
          return yield* decodeSnapshot({
            url: result.observed.url,
            title: result.observed.title,
            loading: false,
            visibleText: withOmitted(boundText(scoped ? text : capLongNames(text)), result.omitted),
            interactiveElements: [],
            accessibilityTree: null,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
            screenshot: result.screenshot,
          }).pipe(Effect.mapError((cause) => failure("invalid-response", cause)));
        }
        if (request.operation === "resize" && action.viewport !== undefined) {
          const rendered = yield* decodeRendered(response.result).pipe(
            Effect.mapError((cause) => failure("invalid-response", cause)),
          );
          const tabId = binding.tabId;
          const viewport = action.viewport._tag === "fill" ? undefined : action.viewport;
          yield* save(
            (yield* Ref.get(state)).map((tab) => {
              if (tab.tabId !== tabId) return tab;
              const { viewport: _previous, ...rest } = tab;
              return viewport === undefined ? rest : { ...rest, viewport };
            }),
          );
          setCurrent();
          return { tabId, setting: action.viewport, viewport: rendered };
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
          : { tabId: binding.tabId, backend: "phi" };
      }),
    ),
  );

  const service = PhiBrowser.of({
    availability,
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
  const recovery = yield* Effect.forEach(
    retired,
    (sessionId) => service.releaseSession(sessionId),
    {
      discard: true,
    },
  ).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Fiber.interrupt(recovery);
      const sessions = new Set((yield* Ref.get(state)).map((tab) => tab.sessionId));
      yield* Effect.forEach(sessions, (id) => service.releaseSession(id), { discard: true });
    }),
  );
  return service;
});

export const layer = Layer.effect(PhiBrowser, make);
