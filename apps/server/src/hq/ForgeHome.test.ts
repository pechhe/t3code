import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Project as T3Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeUtil from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ForgeHome from "./ForgeHome.ts";
import { hqHomeWithOwnerCard, hqHomeWithStuckLine } from "./ForgeHome.hqFixtures.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

const origin = "https://hq.example.test";
const delegation = `yshqd_${"d".repeat(43)}`;
const environmentId = EnvironmentId.make("environment-t3");
const leadThread = ThreadId.make("mcp:thread-lead");
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const item = (number: number, title = `Spec ${number}`) => ({
  id: `item-${number}`,
  number,
  title,
  status: "landed",
});
const card = {
  bodyRevision: 3,
  published: [{ repository: "pechhe/yardsmith", revision: "abc" }],
  reviewRunId: "run-1",
};
const acceptance = {
  kind: "acceptance",
  spec: {
    ...item(4071),
    readiness: {
      rows: [{ rowId: "r1", text: "Home lists today first", verdict: "met", evidence: "seen" }],
      staging: { state: "carried" },
      checks: [
        { label: "Deployed on staging", met: true },
        { label: "1 of 1 rows met", met: true },
        { label: "No blocking finding", met: true },
        { label: "Gate: No gate", met: null },
      ],
    },
    undecidedFindings: [],
    personFindings: [],
    reviewSummary: "Home opens on today's routes.",
    tryIt: "staging /home",
    card,
  },
};
const homeValue = {
  needsYou: [acceptance],
  stuck: [
    {
      kind: "review_missing",
      spec: item(3180),
      blocker: "no review",
      fix: "re-run it",
      since: "t",
      prompt: "Re-run the review of #3180",
    },
  ],
  inProgress: [{ spec: item(4062), liveLead: true }],
  count: 2,
};

const makeHarness = Effect.gen(function* () {
  const stored = new Map<string, Uint8Array>();
  const hq = {
    calls: [] as Array<{ url: string; auth: string; body: Record<string, unknown> }>,
    unreachable: false,
    status: 200,
    /** Answers one call; tests replace it. */
    answer: (body: Record<string, unknown>): { status: number; json: unknown } =>
      body.action === "notes"
        ? { status: 400, json: { error: "action_invalid" } }
        : body.action === "home"
          ? { status: 200, json: { status: "succeeded", value: homeValue } }
          : { status: 200, json: { status: "succeeded", value: {} } },
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (hq.unreachable)
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        });
      const body = parseJson(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ) as Record<string, unknown>;
      // An agent's exchange and MCP calls go to Weave too; they are not Forge decisions.
      const path = new URL(request.url).pathname;
      if (path === "/api/mcp/agents")
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              token: `yshqa_${"t".repeat(43)}`,
              expiresAt: "2099-01-01T00:00:00.000Z",
              agent: { executingAgentId: "agent:1", role: "lead", model: "m" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      if (path === "/api/mcp")
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      hq.calls.push({ url: request.url, auth: request.headers.authorization ?? "", body });
      const answer =
        hq.status === 200 ? hq.answer(body) : { status: hq.status, json: { error: "x" } };
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.json), { status: answer.status }),
      );
    }),
  );
  const world = {
    projects: [] as T3Project[],
    launches: [] as ThreadLaunch.ThreadLaunchInput[],
    launchAttempts: [] as ThreadLaunch.ThreadLaunchInput[],
    sendAttempts: [] as string[],
    failAfterSend: false,
    failAfterLaunch: false,
    refuseLaunch: false,
    sent: [] as Array<{ threadId: string; commandId: string; text: string }>,
    shell: { deletedAt: null, archivedAt: null, projectId: ProjectId.make("project-1") } as Record<
      string,
      unknown
    > | null,
  };
  const logs: string[] = [];
  const logLayer = Logger.layer(
    [Logger.make(({ message }) => void logs.push(NodeUtil.inspect(message, { depth: 10 })))],
    { mergeWithExisting: false },
  );
  const platform = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      } as ServerSecretStore.ServerSecretStore["Service"]),
    ),
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
      } as ServerEnvironment.ServerEnvironment["Service"]),
    ),
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  );
  // T3's own Weave connection: decisions go out with the delegation it stores.
  const deps = Layer.mergeAll(
    platform,
    ServerSettings.layerTest({ defaultRuntimeMode: "full-access" }),
    HqAgentConnections.layer.pipe(Layer.provide(platform)),
    // Models the command receipt boundary: attempts remain visible even when a retry replays a receipt.
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed((id.startsWith("build-note:") ? null : world.shell) as never),
      sendToThread: (input) =>
        Effect.gen(function* () {
          world.sendAttempts.push(input.commandId);
          if (!world.sent.some((sent) => sent.commandId === input.commandId))
            world.sent.push({
              threadId: input.threadId,
              commandId: input.commandId,
              text: input.text,
            });
          if (world.failAfterSend) {
            world.failAfterSend = false;
            return yield* Effect.die("process stopped after the send committed");
          }
          return {} as never;
        }),
    }),
    Layer.mock(Project.ProjectService)({
      snapshot: Effect.sync(() => ({ projects: world.projects }) as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          world.launchAttempts.push(input);
          if (!world.launches.some((launch) => launch.commandId === input.commandId))
            world.launches.push(input);
          if (world.refuseLaunch)
            return yield* new ThreadLaunch.ThreadLaunchForgeItemError({
              projectId: input.projectId,
              forgeItem: 4530,
            });
          if (world.failAfterLaunch) {
            world.failAfterLaunch = false;
            return yield* Effect.die("process stopped after the launch committed");
          }
          return { threadId: input.threadId } as never;
        }),
    }),
  );
  // One database for every boot, as the file is across a restart.
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3code-build-home-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const database = yield* Layer.build(
    Layer.mergeAll(SqlitePersistence.layerMemory.pipe(Layer.provide(config)), config),
  );
  const databaseLayer = Layer.succeedContext(database);

  /** A server process over the shared state; closing its scope stops it, as a restart does. */
  const boot = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      ForgeHome.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(deps, databaseLayer)),
        Layer.provide(logLayer),
      ),
      scope,
    );
    return {
      service: Context.get(context, ForgeHome.ForgeHome),
      connections: Context.get(context, HqAgentConnections.HqAgentConnections),
      stop: Scope.close(scope, Exit.void),
    };
  });
  return { hq, world, logs, stored, boot };
});

const connected = Effect.gen(function* () {
  const h = yield* makeHarness;
  const server = yield* h.boot;
  yield* server.connections.connect({ origin, delegation });
  return { ...h, ...server };
});

it.effect("is not connected without an HQ connection and asks HQ nothing", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    const { service } = yield* h.boot;
    const state = yield* service.read;
    assert.strictEqual(state.status, "not_connected");
    assert.strictEqual(state.home, null);
    assert.strictEqual(h.hq.calls.length, 0);
  }),
);

it.effect("reads Home with T3's delegation, never shows it, and says when HQ refuses it", () =>
  Effect.gen(function* () {
    const { hq, service, logs } = yield* connected;
    const state = yield* service.read;
    assert.strictEqual(state.status, "ready");
    assert.strictEqual(state.home?.count, 1);
    assert.strictEqual(state.buildUrl, "https://hq.example.test/build");
    const need = state.home?.needsYou[0];
    assert.strictEqual(need?.kind, "acceptance");
    if (need?.kind === "acceptance") {
      assert.deepStrictEqual(
        need.checks.map((check) => check.met),
        [true, true, true, null],
      );
      assert.deepStrictEqual(need.repositories, ["pechhe/yardsmith"]);
    }
    assert.isFalse("stuck" in state.home!);
    assert.isFalse("inProgress" in state.home!);
    assert.strictEqual(hq.calls[0]?.url, `${origin}/api/build/decisions`);
    assert.strictEqual(hq.calls[0]?.auth, `Bearer ${delegation}`);
    // Neither the state a client receives, nor a log, carries the delegation or a stuck line's prompt.
    const surfaces = NodeUtil.inspect([state, logs], { depth: 20 });
    assert.notInclude(surfaces, delegation);
    assert.notInclude(surfaces, "Re-run the review of #3180");

    hq.status = 401;
    yield* TestClock.adjust(60_000);
    // A lapsed read answers with what it knew and refreshes behind it.
    assert.strictEqual((yield* service.read).status, "ready");
    yield* service.refreshed;
    assert.strictEqual((yield* service.read).status, "invalid_token");
    hq.status = 200;
    yield* TestClock.adjust(60_000);
    yield* service.read;
    yield* service.refreshed;
    assert.strictEqual((yield* service.read).status, "ready");
  }),
);

it.effect("a read after Home lapses answers with what it knew and refreshes behind it", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    const first = yield* service.read;
    const known = hq.calls.length;
    hq.answer = (body) =>
      body.action === "notes"
        ? { status: 400, json: { error: "action_invalid" } }
        : body.action === "home"
          ? {
              status: 200,
              json: {
                status: "succeeded",
                value: {
                  ...homeValue,
                  needsYou: Array.from({ length: 7 }, () => acceptance),
                  count: 7,
                },
              },
            }
          : { status: 200, json: { status: "succeeded", value: {} } };
    yield* TestClock.adjust(60_000);
    const lapsed = yield* service.read;
    assert.strictEqual(lapsed.home?.count, first.home?.count);
    yield* service.refreshed;
    assert.strictEqual(hq.calls.length, known + 1);
    assert.strictEqual((yield* service.read).home?.count, 7);
    assert.strictEqual(hq.calls.length, known + 1);
  }),
);

it.effect("an agent's Forge writes do not make Home read again before its interval lapses", () =>
  Effect.gen(function* () {
    const { hq, service, connections } = yield* connected;
    yield* service.read;
    const homeCalls = () => hq.calls.filter((call) => call.body.action === "home").length;
    const known = homeCalls();
    yield* connections.prepare({ threadId: leadThread, role: "lead", model: "claude-opus-5-5" });
    const agent = yield* connections.connection(leadThread);
    const version = yield* connections.buildWriteVersion;
    for (const id of [1, 2, 3]) {
      yield* connections.forward({
        authorization: agent!.authorizationHeader,
        contentType: undefined,
        accept: undefined,
        protocolVersion: undefined,
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "hq_build_set_status", arguments: {} },
          }),
        ),
      });
    }
    assert.isAbove(yield* connections.buildWriteVersion, version);
    yield* TestClock.adjust(30_000);
    yield* service.read;
    yield* service.refreshed;
    assert.strictEqual(homeCalls(), known);
    yield* TestClock.adjust(60_000);
    yield* service.read;
    yield* service.refreshed;
    assert.strictEqual(homeCalls(), known + 1);
  }),
);

it.effect("an HQ that keeps failing is asked less often each time", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    hq.status = 503;
    const attempts = Effect.gen(function* () {
      const before = hq.calls.filter((c) => c.body.action === "home").length;
      yield* service.read;
      yield* service.refreshed;
      return hq.calls.filter((c) => c.body.action === "home").length - before;
    });
    assert.strictEqual(yield* attempts, 1);
    // Failures wait 60s, then 120s, then 240s before the next attempt reaches Weave.
    for (const waitMs of [60_000, 120_000, 240_000]) {
      yield* TestClock.adjust(waitMs - 1);
      assert.strictEqual(yield* attempts, 0);
      yield* TestClock.adjust(1);
      assert.strictEqual(yield* attempts, 1);
    }
  }),
);

it.effect("reads Home as HQ actually answers it: an owner card, then a stuck line", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    let home: unknown = hqHomeWithOwnerCard;
    hq.answer = (body) =>
      body.action === "notes"
        ? { status: 400, json: { error: "action_invalid" } }
        : body.action === "home"
          ? { status: 200, json: { status: "succeeded", value: home } }
          : { status: 200, json: { status: "succeeded", value: {} } };
    yield* TestClock.adjust(60_000);
    const withCard = yield* service.read;
    assert.strictEqual(withCard.status, "ready");
    assert.strictEqual(withCard.home?.count, 1);
    const need = withCard.home?.needsYou[0];
    assert.strictEqual(need?.kind, "acceptance");
    if (need?.kind === "acceptance") {
      // The card shows Weave's own checks, so Weave and T3 cannot disagree about them.
      assert.deepStrictEqual(need.checks, hqHomeWithOwnerCard.needsYou[0]?.spec.readiness.checks);
      assert.strictEqual(need.reviewSummary, "Exports now include every row");
      assert.strictEqual(need.tryIt, "https://staging.example/exports");
      assert.deepStrictEqual(need.card, hqHomeWithOwnerCard.needsYou[0]?.spec.card);
    }

    // A Weave server from before the checks were projected still shows the card, without checks.
    const [entry] = hqHomeWithOwnerCard.needsYou;
    const { checks: _checks, ...readiness } = entry!.spec.readiness;
    home = {
      ...hqHomeWithOwnerCard,
      needsYou: [{ ...entry, spec: { ...entry!.spec, readiness } }],
    };
    yield* TestClock.adjust(60_000);
    yield* service.read;
    yield* service.refreshed;
    const withoutChecks = (yield* service.read).home?.needsYou[0];
    assert.strictEqual(withoutChecks?.kind, "acceptance");
    if (withoutChecks?.kind === "acceptance") {
      assert.deepStrictEqual(withoutChecks.checks, []);
      assert.deepStrictEqual(withoutChecks.card, entry?.spec.card);
    }

    home = hqHomeWithStuckLine;
    yield* TestClock.adjust(60_000);
    yield* service.read;
    yield* service.refreshed;
    const withStuck = yield* service.read;
    assert.strictEqual(withStuck.home?.count, 0);
    assert.deepStrictEqual(withStuck.home?.needsYou, []);
    assert.isFalse("stuck" in withStuck.home!);
  }),
);

it.effect("the retired decision token is removed, and decisions follow T3's HQ connection", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    h.stored.set("hq-build-decisions", new TextEncoder().encode("retired"));
    const { service, connections } = yield* h.boot;
    assert.isFalse(h.stored.has("hq-build-decisions"));
    yield* connections.connect({ origin, delegation });
    assert.strictEqual((yield* service.read).status, "ready");
    yield* connections.disconnect;
    assert.strictEqual((yield* service.read).status, "not_connected");
    const refused = yield* service
      .decide({ specId: "item-4071", decision: "accept", card })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "not_connected");
    assert.isFalse(h.hq.calls.some((call) => call.body.action === "decide"));
  }),
);

it.effect("an Accept records the decision as T3 and re-reads Home", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    yield* service.read;
    const homeReads = () => hq.calls.filter((call) => call.body.action === "home").length;
    const before = homeReads();
    const result = yield* service.decide({ specId: "item-4071", decision: "accept", card });
    assert.strictEqual(result.outcome, "decided");
    assert.deepStrictEqual(hq.calls.find((call) => call.body.action === "decide")?.body, {
      action: "decide",
      specId: "item-4071",
      decision: "accept",
      card,
      via: { client: "t3", environmentId },
    });
    assert.strictEqual(homeReads(), before + 1);
  }),
);

it.effect("a stale card is refreshed and said so", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    hq.answer = (body) =>
      body.action === "notes"
        ? { status: 400, json: { error: "action_invalid" } }
        : body.action === "decide"
          ? { status: 409, json: { status: "stale", code: "acceptance_card_stale" } }
          : { status: 200, json: { status: "succeeded", value: homeValue } };
    const result = yield* service.decide({ specId: "item-4071", decision: "accept", card });
    assert.strictEqual(result.outcome, "stale");
    assert.strictEqual(result.state.status, "ready");
    assert.include(result.message, "changed");
    // A Send back without a note is refused with a short message, not a failure.
    hq.answer = () => ({
      status: 400,
      json: { status: "invalid", code: "send_back_note_required" },
    });
    const refused = yield* service.decide({ specId: "item-4071", decision: "send_back", card });
    assert.deepStrictEqual(
      [refused.outcome, refused.message],
      ["refused", "Add a note to send this back."],
    );
  }),
);

const sendBackAnswer =
  (lead: { harness: string; sessionRef: string } | null, deliveryStatus = 200) =>
  (body: Record<string, unknown>) => {
    if (body.action === "notes") return { status: 400, json: { error: "action_invalid" } };
    if (body.action === "decide")
      return {
        status: 200,
        json: {
          status: "succeeded",
          value: {
            spec: item(4071),
            finding: { id: "finding-1", note: "Routes are in the wrong order" },
            leadThread: lead,
          },
        },
      };
    if (body.action === "delivery")
      return { status: deliveryStatus, json: { status: "succeeded" } };
    return { status: 200, json: { status: "succeeded", value: homeValue } };
  };
const deliveries = (hq: { calls: Array<{ body: Record<string, unknown> }> }) =>
  hq.calls.filter((call) => call.body.action === "delivery").map((call) => call.body);
const sendBack = {
  specId: "item-4071",
  decision: "send_back",
  card,
  note: "Routes are in the wrong order",
} as const;
/** As a T3 lead reports its session to Forge: harness `t3code`, its thread id as `sessionRef`. */
const leadRef = { harness: "t3code", sessionRef: leadThread };

it("names the lead's T3 thread from either session form, and nothing else", () => {
  assert.deepStrictEqual(
    ForgeHome.leadThreadOf({ harness: "t3code", sessionRef: "mcp:af171d33" }),
    {
      environmentId: null,
      threadId: "mcp:af171d33",
    },
  );
  assert.deepStrictEqual(ForgeHome.leadThreadOf({ harness: "t3", sessionRef: "env-1/thread-1" }), {
    environmentId: "env-1",
    threadId: "thread-1",
  });
  // T3 thread ids carry their creation prefix (`mcp:` for a thread an agent launched); it is part of the id.
  assert.deepStrictEqual(
    ForgeHome.leadThreadOf({ harness: "t3", sessionRef: "env-1/mcp:af171d33" }),
    { environmentId: "env-1", threadId: "mcp:af171d33" },
  );
  assert.strictEqual(
    ForgeHome.leadThreadOf({ harness: "codex-cli", sessionRef: "thread-1" }),
    null,
  );
  assert.strictEqual(ForgeHome.leadThreadOf({ harness: "t3code", sessionRef: "a/b/c" }), null);
  assert.strictEqual(ForgeHome.leadThreadOf({ harness: "t3code", sessionRef: "" }), null);
});

it.effect("a delivery is reported only to the HQ that recorded the finding", () =>
  Effect.gen(function* () {
    const { hq, world, service, connections } = yield* connected;
    hq.answer = sendBackAnswer(leadRef, 503);
    yield* service.decide(sendBack);
    assert.strictEqual(world.sent.length, 1);
    const before = deliveries(hq).length;
    // Reconnected to another Weave: it never hears of a finding it did not record.
    yield* connections.connect({ origin: "https://other-hq.example.test", delegation });
    hq.answer = sendBackAnswer(leadRef, 200);
    yield* TestClock.adjust(10 * 60_000);
    assert.strictEqual(deliveries(hq).length, before);
    yield* connections.connect({ origin, delegation });
    yield* TestClock.adjust(10 * 60_000);
    assert.strictEqual(deliveries(hq).at(-1)?.state, "delivered");
    assert.strictEqual(world.sent.length, 1);
  }),
);

it.effect("a Send back reaches the lead thread once and is reported delivered", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    hq.answer = sendBackAnswer(leadRef);
    yield* service.decide(sendBack);
    assert.strictEqual(world.sent.length, 1);
    assert.strictEqual(world.sent[0]?.threadId, leadThread);
    assert.strictEqual(world.sent[0]?.commandId, "build-send-back:finding-1");
    assert.include(world.sent[0]?.text, "Routes are in the wrong order");
    assert.include(world.sent[0]?.text, "#4071");
    assert.deepStrictEqual(deliveries(hq), [
      { action: "delivery", findingId: "finding-1", state: "delivered" },
    ]);
    // Nothing more is sent or reported, however long the loop runs.
    yield* TestClock.adjust(10 * 60_000);
    assert.strictEqual(world.sent.length, 1);
    assert.strictEqual(deliveries(hq).length, 1);
  }),
);

it.effect(
  "a report HQ did not take is retried, across a restart, without sending the note again",
  () =>
    Effect.gen(function* () {
      const h = yield* connected;
      const { hq, world, service } = h;
      hq.answer = sendBackAnswer(leadRef, 503);
      yield* service.decide(sendBack);
      assert.strictEqual(world.sent.length, 1);
      assert.isAbove(deliveries(hq).length, 0);

      // Still down after a retry, then the process restarts and Weave is back.
      yield* TestClock.adjust(5_000);
      assert.strictEqual(world.sent.length, 1);
      yield* h.stop;
      hq.answer = sendBackAnswer(leadRef, 200);
      const restarted = yield* h.boot;
      yield* TestClock.adjust(1);
      assert.strictEqual(world.sent.length, 1);
      assert.strictEqual(deliveries(hq).at(-1)?.state, "delivered");
      const count = deliveries(hq).length;
      yield* TestClock.adjust(10 * 60_000);
      assert.strictEqual(deliveries(hq).length, count);
      yield* restarted.stop;
    }),
);

it.effect("a lead that cannot be written to is reported undeliverable", () =>
  Effect.gen(function* () {
    const cases = [
      [null, "no lead session", null],
      [{ harness: "codex-cli", sessionRef: "x" }, "not a T3 thread", null],
      [
        { harness: "t3", sessionRef: `other-environment/${leadThread}` },
        "another T3 environment",
        null,
      ],
      [leadRef, "no longer exists", "gone"],
      [leadRef, "archived", "archived"],
    ] as const;
    for (const [lead, detail, shell] of cases) {
      const { hq, world, service } = yield* connected;
      hq.answer = sendBackAnswer(lead);
      world.shell =
        shell === "gone"
          ? null
          : {
              deletedAt: null,
              archivedAt: shell === "archived" ? "2026-10-20T00:00:00Z" : null,
              projectId: "p",
            };
      yield* service.decide(sendBack);
      assert.strictEqual(world.sent.length, 0);
      const report = deliveries(hq)[0];
      assert.strictEqual(report?.state, "undeliverable");
      assert.include(String(report?.detail).toLowerCase(), detail.toLowerCase());
    }
  }),
);

const note = (
  id = "note-1",
  lead: { harness: string; sessionRef: string } | null = {
    harness: "t3code",
    sessionRef: `${environmentId}/${leadThread}`,
  },
) => ({
  id,
  note: "Use the current route",
  kind: "send_back" as "send_back" | "answer" | "decision" | "gate_removal",
  spec: { id: "spec-1", number: 4530, ref: "YS-260", title: "Inbox", project: "pechhe/yardsmith" },
  decision: null as { number: number; ref: string | null; title: string } | null,
  leadThread: lead,
  claim: null as { environmentId: string } | null,
});
const project: T3Project = {
  id: ProjectId.make("project-1"),
  title: "YardSmith",
  workspaceRoot: "/yardsmith",
  repositoryIdentity: {
    canonicalKey: "github.com/pechhe/yardsmith",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:pechhe/yardsmith.git",
    },
    origin: { canonicalKey: "github.com/other/upstream" },
  },
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex_custom"),
    model: "gpt-5.1-codex",
  },
  scripts: [],
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  deletedAt: null,
};
const noteAnswer =
  (notes: ReturnType<typeof note>[], deliveryStatus = 200, claimStatus = "succeeded") =>
  (body: Record<string, unknown>) => ({
    status: body.action === "delivery" ? deliveryStatus : 200,
    json: {
      status: body.action === "claim" ? claimStatus : "succeeded",
      ...(body.action === "claim" && claimStatus !== "succeeded"
        ? { code: "note_claimed_elsewhere" }
        : {}),
      value: body.action === "notes" ? notes : homeValue,
    },
  });

it.effect(
  "decodes old needs without findings or obsolete sections and probes once per connection",
  () =>
    Effect.gen(function* () {
      const { hq, service, connections } = yield* connected;
      const oldAnswer = hq.answer;
      hq.answer = (body) =>
        body.action === "home"
          ? {
              status: 200,
              json: {
                status: "succeeded",
                value: {
                  needsYou: [
                    acceptance,
                    { kind: "finding", item: item(1) },
                    {
                      kind: "hold",
                      item: item(2),
                      hold: { kind: "decision", note: "Choose a route" },
                    },
                  ],
                  stuck: "unreadable",
                  inProgress: false,
                },
              },
            }
          : oldAnswer(body);
      const state = yield* service.read;
      assert.deepStrictEqual(state.home?.capabilities, { answer: false, notes: false });
      assert.strictEqual(state.home?.count, 2);
      const needs = state.home!.needsYou;
      assert.deepStrictEqual(needs[0]?.kind === "acceptance" && needs[0].resolvedFindings, []);
      assert.deepStrictEqual(needs[1], {
        kind: "hold",
        spec: { ...item(2), ref: null },
        url: `${origin}/forge/2`,
        holdId: null,
        holdKind: "decision",
        question: "Choose a route",
        since: null,
      });
      yield* service.settleDeliveries;
      yield* service.answer({ itemId: "item-2", holdId: "hold-1", answer: "A" });
      assert.strictEqual(hq.calls.filter((c) => c.body.action === "notes").length, 1);
      assert.strictEqual(hq.calls.filter((c) => c.body.action === "answer").length, 0);
      // An older Weave is asked again after a while, so a Weave server update needs no T3 restart.
      yield* TestClock.adjust("5 minutes");
      yield* service.read;
      assert.strictEqual(hq.calls.filter((c) => c.body.action === "notes").length, 2);
      yield* connections.connect({ origin: "https://new-hq.example.test", delegation });
      yield* service.read;
      assert.strictEqual(hq.calls.filter((c) => c.body.action === "notes").length, 3);
    }),
);

it.effect("decodes Inbox holds, resolved findings, decisions and Arc actions", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    hq.answer = (body) => ({
      status: 200,
      json: {
        status: "succeeded",
        value:
          body.action === "notes"
            ? []
            : {
                needsYou: [
                  {
                    ...acceptance,
                    decisions: [item(6)],
                    spec: {
                      ...acceptance.spec,
                      resolvedFindings: [
                        { runId: "r1", finding: { summary: "Fixed route", severity: "blocking" } },
                      ],
                    },
                  },
                  {
                    kind: "hold",
                    item: item(2),
                    hold: {
                      id: "hold-1",
                      kind: "decision",
                      note: "Choose",
                      openedAt: "2026-10-20",
                    },
                  },
                  { kind: "decision", decision: item(3) },
                  { ...acceptance, decisions: [item(6)], spec: { ...acceptance.spec, ...item(7) } },
                  { kind: "arc_review", arc: item(4) },
                  { kind: "arc_check_in", arc: item(5), since: "2026-10-19" },
                ],
              },
      },
    });
    const home = (yield* service.read).home!;
    assert.deepStrictEqual(home.capabilities, { answer: true, notes: true });
    // A Decision nested in two Specs' cards is listed once, after the first.
    assert.strictEqual(home.count, 7);
    assert.deepStrictEqual(
      home.needsYou[0]?.kind === "acceptance" && home.needsYou[0].resolvedFindings,
      [{ title: "Fixed route" }],
    );
    assert.strictEqual(home.needsYou[2]?.kind === "hold" && home.needsYou[2].holdId, "hold-1");
    assert.deepStrictEqual(
      home.needsYou
        .filter((_, index) => index !== 0 && index !== 2)
        .map((n) => [n.kind, n.url, "detail" in n ? n.detail : null]),
      [
        ["decision", `${origin}/forge/6`, null],
        ["decision", `${origin}/forge/3`, null],
        ["acceptance", `${origin}/forge/7`, null],
        ["arc_review", `${origin}/forge/4`, "Review date reached: continue or close"],
        ["arc_check_in", `${origin}/forge/5`, "No check-in since 2026-10-19"],
      ],
    );
  }),
);

it.effect("claims only locally owned or unowned notes and respects existing claims", () =>
  Effect.gen(function* () {
    for (const [lead, present, claimedBy, expected] of [
      [{ harness: "t3code", sessionRef: `${environmentId}/${leadThread}` }, false, null, true],
      [{ harness: "t3code", sessionRef: `elsewhere/${leadThread}` }, true, null, false],
      [{ harness: "t3code", sessionRef: leadThread }, true, null, true],
      [{ harness: "t3code", sessionRef: leadThread }, false, null, false],
      [null, false, null, true],
      [{ harness: "codex", sessionRef: "outside" }, false, null, true],
      [null, false, "elsewhere", false],
      [null, false, environmentId, true],
    ] as const) {
      const { hq, world, service } = yield* connected;
      if (!present) world.shell = null;
      const n = note("note-claim", lead);
      n.claim = claimedBy === null ? null : { environmentId: claimedBy };
      hq.answer = noteAnswer([n]);
      yield* service.settleDeliveries;
      assert.strictEqual(
        hq.calls.some((c) => c.body.action === "claim"),
        expected,
      );
      assert.strictEqual(deliveries(hq).length, expected ? 1 : 0);
    }
  }),
);

it.effect("does not deliver a claim HQ refused", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    hq.answer = noteAnswer([note()], 200, "refused");
    yield* service.settleDeliveries;
    assert.strictEqual(world.sent.length, 0);
    assert.deepStrictEqual(deliveries(hq), []);
  }),
);

it.effect("queues a claimed note with a deterministic message and reports its destination", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    hq.answer = noteAnswer([note()]);
    yield* service.settleDeliveries;
    yield* service.settleDeliveries;
    assert.deepStrictEqual(world.sent, [
      {
        threadId: leadThread,
        commandId: "build-send-back:note-1",
        text: "Your owner sent YS-260 back: Use the current route",
      },
    ]);
    assert.deepStrictEqual(deliveries(hq), [
      {
        action: "delivery",
        findingId: "note-1",
        state: "delivered",
        environmentId,
        thread: { harness: "t3code", sessionRef: `${environmentId}/${leadThread}` },
      },
    ]);
  }),
);

it.effect("replays the same message receipt after a crash between send and outbox update", () =>
  Effect.gen(function* () {
    const h = yield* connected;
    h.hq.answer = noteAnswer([note()]);
    h.world.failAfterSend = true;
    yield* h.service.settleDeliveries;
    assert.strictEqual(h.world.sent.length, 1);
    assert.deepStrictEqual(deliveries(h.hq), []);
    yield* h.stop;
    const restarted = yield* h.boot;
    yield* restarted.service.settleDeliveries;
    assert.deepStrictEqual(h.world.sendAttempts, [
      "build-send-back:note-1",
      "build-send-back:note-1",
    ]);
    assert.strictEqual(h.world.sent.length, 1);
    assert.strictEqual(deliveries(h.hq).at(-1)?.state, "delivered");
    yield* restarted.stop;
  }),
);

it.effect(
  "launches a Forge-bound thread with the matching project's default model for missing or archived leads",
  () =>
    Effect.gen(function* () {
      for (const archived of [false, true]) {
        const { hq, world, service } = yield* connected;
        world.projects = [project];
        world.shell = archived ? { archivedAt: "2026-10-20", deletedAt: null } : null;
        hq.answer = noteAnswer([note()]);
        yield* service.settleDeliveries;
        assert.strictEqual(world.launches.length, 1);
        const launched = world.launches[0]!;
        assert.strictEqual(launched.threadId, "build-note:note-1");
        assert.strictEqual(launched.projectId, project.id);
        assert.strictEqual(launched.runtimeMode, "full-access");
        assert.deepStrictEqual(launched.modelSelection, project.defaultModelSelection);
        assert.deepStrictEqual(launched.workspaceStrategy, {
          type: "worktree",
          baseRef: "HEAD",
          forgeItem: 4530,
        });
        assert.strictEqual(
          launched.initialMessage?.text,
          "Your owner sent YS-260 back: Use the current route",
        );
        assert.strictEqual(world.sent.length, 0);
        assert.deepStrictEqual(deliveries(hq)[0]?.thread, {
          harness: "t3code",
          sessionRef: `${environmentId}/build-note:note-1`,
        });
      }
    }),
);

it.effect("reports a note undeliverable when its project cannot open a Forge item workspace", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    world.projects = [project];
    world.shell = null;
    world.refuseLaunch = true;
    hq.answer = noteAnswer([note()]);
    yield* service.settleDeliveries;
    assert.strictEqual(deliveries(hq)[0]?.state, "undeliverable");
    assert.strictEqual(
      deliveries(hq)[0]?.detail,
      "forgeItem picks the item's SlipJay workspace: use it in a project with slipjay.json.",
    );
  }),
);

it.effect("replays the same launch receipt after a crash without creating a second thread", () =>
  Effect.gen(function* () {
    const h = yield* connected;
    h.world.projects = [project];
    h.world.shell = null;
    h.world.failAfterLaunch = true;
    h.hq.answer = noteAnswer([note()]);
    yield* h.service.settleDeliveries;
    assert.strictEqual(h.world.launches.length, 1);
    yield* h.stop;
    const restarted = yield* h.boot;
    yield* restarted.service.settleDeliveries;
    assert.strictEqual(h.world.launches.length, 1);
    assert.deepStrictEqual(
      h.world.launchAttempts.map((a) => [
        String(a.threadId),
        String(a.commandId),
        String(a.initialMessage?.messageId),
      ]),
      [
        ["build-note:note-1", "build-note:note-1", "build-send-back:note-1"],
        ["build-note:note-1", "build-note:note-1", "build-send-back:note-1"],
      ],
    );
    assert.strictEqual(deliveries(h.hq).at(-1)?.state, "delivered");
    yield* restarted.stop;
  }),
);

it.effect("reports an unowned note undeliverable when no project matches", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    hq.answer = noteAnswer([note("no-project", null)]);
    yield* service.settleDeliveries;
    assert.strictEqual(world.launches.length, 0);
    assert.strictEqual(deliveries(hq)[0]?.state, "undeliverable");
    assert.strictEqual(
      deliveries(hq)[0]?.detail,
      "No registered T3 project matches pechhe/yardsmith.",
    );
  }),
);

it.effect("refuses answers on older HQ and delivers new HQ answers through the note loop", () =>
  Effect.gen(function* () {
    const old = yield* connected;
    const input = { itemId: "item-1", holdId: "hold-1", answer: "Use the current route" };
    const refused = yield* old.service.answer(input);
    assert.strictEqual(refused.outcome, "refused");
    assert.include(refused.message!, "does not support answering holds");
    assert.isFalse(old.hq.calls.some((c) => c.body.action === "answer"));

    const { hq, world, service } = yield* connected;
    const n = note();
    n.kind = "answer";
    let answered = false;
    const respond = noteAnswer([]);
    hq.answer = (body) => {
      if (body.action === "answer") answered = true;
      return body.action === "notes" ? noteAnswer(answered ? [n] : [])(body) : respond(body);
    };
    assert.strictEqual((yield* service.answer(input)).outcome, "decided");
    assert.deepStrictEqual(hq.calls.find((c) => c.body.action === "answer")?.body, {
      action: "answer",
      ...input,
      via: { client: "t3", environmentId },
    });
    assert.strictEqual(
      world.sent[0]?.text,
      "Your owner answered your hold on YS-260: Use the current route",
    );
  }),
);

it.effect("delivers a note sent back on a Proposed Decision to its source Spec's lead", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    const n = note();
    n.kind = "decision";
    n.note = "Only your own number counts";
    n.decision = { number: 4548, ref: null, title: "Hum acts on your WhatsApp instruction" };
    hq.answer = noteAnswer([n]);
    yield* service.settleDeliveries;
    assert.strictEqual(
      world.sent[0]?.text,
      "Your owner sent back Decision #4548 “Hum acts on your WhatsApp instruction”, which YS-260 proposed, to revise or drop: Only your own number counts",
    );
    assert.strictEqual(deliveries(hq).at(-1)?.state, "delivered");
  }),
);

it.effect("delivers a gate-removal note as Forge's own job, not the owner's words", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    const n = note();
    n.kind = "gate_removal";
    n.note = "Remove its Spec gate and land it as a chore.";
    hq.answer = noteAnswer([n]);
    yield* service.settleDeliveries;
    assert.strictEqual(
      world.sent[0]?.text,
      "YS-260 was accepted. Remove its Spec gate and land it as a chore.",
    );
    assert.strictEqual(deliveries(hq).at(-1)?.state, "delivered");
  }),
);

it.effect("skips a note of a kind it does not know and still delivers the others", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    const unknown = { ...note("note-unknown"), kind: "something_new" };
    hq.answer = noteAnswer([unknown as unknown as ReturnType<typeof note>, note("note-known")]);
    yield* service.settleDeliveries;
    assert.strictEqual(world.sent.length, 1);
    assert.strictEqual(world.sent[0]?.text, "Your owner sent YS-260 back: Use the current route");
  }),
);

it.effect("names no Decision when the viewer cannot see the one sent back", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    const n = note();
    n.kind = "decision";
    n.note = "Only your own number counts";
    n.decision = null;
    hq.answer = noteAnswer([n]);
    yield* service.settleDeliveries;
    assert.strictEqual(
      world.sent[0]?.text,
      "Your owner sent back a Decision that YS-260 proposed, to revise or drop: Only your own number counts",
    );
  }),
);

it.effect(
  "delivers a note sent to a new thread after this environment reported it undeliverable",
  () =>
    Effect.gen(function* () {
      const { hq, world, service } = yield* connected;
      hq.answer = noteAnswer([note("note-1", null)]);
      yield* service.settleDeliveries;
      assert.strictEqual(deliveries(hq)[0]?.state, "undeliverable");
      // "Start a new thread instead": Weave lists it as pending again, and this environment claims it.
      world.projects = [project];
      yield* service.settleDeliveries;
      assert.strictEqual(world.launches.length, 1);
      assert.strictEqual(deliveries(hq).at(-1)?.state, "delivered");
      yield* service.settleDeliveries;
      assert.strictEqual(world.launches.length, 1);
    }),
);

it.effect("a note sent to a new thread before its delivery leaves its old lead", () =>
  Effect.gen(function* () {
    const { hq, world, service } = yield* connected;
    world.projects = [project];
    hq.answer = noteAnswer([note()], 503);
    yield* service.settleDeliveries;
    assert.strictEqual(world.sent[0]?.threadId, leadThread);
    hq.answer = noteAnswer([note("note-1", null)]);
    yield* service.settleDeliveries;
    assert.strictEqual(world.launches.length, 1);
    assert.deepStrictEqual(deliveries(hq).at(-1)?.thread, {
      harness: "t3code",
      sessionRef: `${environmentId}/build-note:note-1`,
    });
  }),
);

it.effect("stops reporting a note HQ says is now another environment's", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    const respond = noteAnswer([note()]);
    let listed = true;
    hq.answer = (body) =>
      body.action === "delivery"
        ? { status: 409, json: { status: "refused", code: "note_claimed_elsewhere" } }
        : body.action === "notes"
          ? noteAnswer(listed ? [note()] : [])(body)
          : respond(body);
    yield* service.settleDeliveries;
    listed = false;
    const reports = deliveries(hq).length;
    assert.deepStrictEqual(yield* service.settleDeliveries, { failed: 0 });
    assert.strictEqual(deliveries(hq).length, reports);
  }),
);
