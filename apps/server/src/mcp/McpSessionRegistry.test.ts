import * as PhiBrowser from "../preview/PhiBrowser.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect(
  "releases Phi resources when a credential expires and retains its session-start selection",
  () =>
    Effect.gen(function* () {
      let timestamp = 1000;
      const released: Array<string> = [];
      const releasedOnce = yield* Deferred.make<void>();
      const phi = PhiBrowser.PhiBrowser.of({
        availability: () => Effect.succeed("available"),
        hasTab: () => Effect.succeed(false),
        invoke: () => Effect.die("unused"),
        list: () => Effect.succeed([]),
        releaseSession: (id) =>
          Effect.sync(() => {
            released.push(id);
          }).pipe(Effect.andThen(Deferred.succeed(releasedOnce, undefined))),
      });
      const registry = yield* makeRegistry(() => timestamp).pipe(
        Effect.provideService(PhiBrowser.PhiBrowser, phi),
      );
      const issued = yield* registry.issue({
        threadId: ThreadId.make("phi-thread"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        browserBackends: { enabled: ["phi"], default: "phi" },
        phiBrowserSkillDirectory: "/fixture/phi",
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const caller = yield* registry.resolve(token);
      expect(caller?.browserBackends).toEqual({ enabled: ["phi"], default: "phi" });
      expect(caller?.phiBrowserSkillDirectory).toBe("/fixture/phi");
      timestamp += 101;
      expect(yield* registry.resolve(token)).toBeUndefined();
      // Cleanup runs off the request path, so wait for it rather than assume it already ran.
      yield* Deferred.await(releasedOnce);
      expect(released).toEqual([issued.config.providerSessionId]);
    }),
);

it.effect("denies a revoked credential at once while its Phi cleanup is still blocked", () =>
  Effect.gen(function* () {
    const releaseStarted = yield* Deferred.make<void>();
    const unblock = yield* Deferred.make<void>();
    const released = yield* Deferred.make<string>();
    const phi = PhiBrowser.PhiBrowser.of({
      availability: () => Effect.succeed("available"),
      hasTab: () => Effect.succeed(false),
      invoke: () => Effect.die("unused"),
      list: () => Effect.succeed([]),
      releaseSession: (id) =>
        Deferred.succeed(releaseStarted, undefined).pipe(
          Effect.andThen(Deferred.await(unblock)),
          Effect.andThen(Deferred.succeed(released, id)),
        ),
    });
    const registry = yield* makeRegistry(() => 1_000).pipe(
      Effect.provideService(PhiBrowser.PhiBrowser, phi),
    );
    const threadId = ThreadId.make("phi-stop-thread");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // The stop returns while the browser is still being closed, and the token is already dead.
    yield* registry.revokeThread(threadId);
    yield* Deferred.await(releaseStarted);
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect(yield* Deferred.isDone(released)).toBe(false);

    // A fresh credential can be issued without waiting on the old session's cleanup.
    yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });

    yield* Deferred.succeed(unblock, undefined);
    expect(yield* Deferred.await(released)).toBe(issued.config.providerSessionId);
  }),
);

it.effect("mints a managed browser credential for the narrow endpoint, pinned to Phi", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-managed-browser"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      managedBrowser: true,
      // Settings that would route a general task to the integrated browser change nothing.
      browserBackends: { enabled: ["integrated"], default: "integrated" },
      capabilities: new Set(["orchestration", "worktree", "device"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp/browser");
    expect(issued.config.managedBrowser).toBe(true);
    const resolved = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(resolved?.capabilities).toEqual(new Set(["preview"]));
    expect(resolved?.managedBrowser).toBe(true);
    expect(resolved?.browserBackends).toEqual({ enabled: ["phi"], default: "phi" });
  }),
);

it.effect("closes a thread's browser tabs and leaves its credential valid", () =>
  Effect.gen(function* () {
    const released: Array<string> = [];
    const releasedOnce = yield* Deferred.make<void>();
    const phi = PhiBrowser.PhiBrowser.of({
      availability: () => Effect.succeed("available"),
      hasTab: () => Effect.succeed(false),
      invoke: () => Effect.die("unused"),
      list: () => Effect.succeed([]),
      releaseSession: (id) =>
        Effect.sync(() => void released.push(id)).pipe(
          Effect.andThen(Deferred.succeed(releasedOnce, undefined)),
        ),
    });
    const registry = yield* makeRegistry(() => 1_000).pipe(
      Effect.provideService(PhiBrowser.PhiBrowser, phi),
    );
    const issue = (threadId: ThreadId) =>
      registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
    const task = yield* issue(ThreadId.make("phi-release-task"));
    yield* issue(ThreadId.make("phi-release-other"));

    yield* registry.releaseThreadBrowser(ThreadId.make("phi-release-task"));
    // Cleanup runs off the request path, so wait for it rather than assume it already ran.
    yield* Deferred.await(releasedOnce);

    expect(released).toEqual([task.config.providerSessionId]);
    expect(
      yield* registry.resolve(task.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toBeDefined();
  }),
);
