import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
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
import { inspect } from "node:util";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BuildHome from "./BuildHome.ts";
import { hqHomeWithOwnerCard, hqHomeWithStuckLine } from "./BuildHome.hqFixtures.ts";
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
      body.action === "home"
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
    sent: [] as Array<{ threadId: string; commandId: string; text: string }>,
    shell: { deletedAt: null, archivedAt: null, projectId: ProjectId.make("project-1") } as Record<
      string,
      unknown
    > | null,
  };
  const logs: string[] = [];
  const logLayer = Logger.layer(
    [Logger.make(({ message }) => void logs.push(inspect(message, { depth: 10 })))],
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
  // T3's own HQ connection: decisions go out with the delegation it stores.
  const deps = Layer.mergeAll(
    platform,
    HqAgentConnections.layer.pipe(Layer.provide(platform)),
    // Not a receipt store: it records every send, so a duplicate would show.
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(world.shell as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          world.sent.push({
            threadId: input.threadId,
            commandId: input.commandId,
            text: input.text,
          });
          return {} as never;
        }),
    }),
    Layer.mock(Project.ProjectService)({}),
    Layer.mock(WorkspaceProvider.WorkspaceProvider)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
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
      BuildHome.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(deps, databaseLayer)),
        Layer.provide(logLayer),
      ),
      scope,
    );
    return {
      service: Context.get(context, BuildHome.BuildHome),
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
    assert.strictEqual(state.home?.count, 2);
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
    assert.strictEqual(state.home?.stuck[0]?.fix, "re-run it");
    assert.strictEqual(hq.calls[0]?.url, `${origin}/api/build/decisions`);
    assert.strictEqual(hq.calls[0]?.auth, `Bearer ${delegation}`);
    // Neither the state a client receives, nor a log, carries the delegation or a stuck line's prompt.
    const surfaces = inspect([state, logs], { depth: 20 });
    assert.notInclude(surfaces, delegation);
    assert.notInclude(surfaces, "Re-run the review of #3180");

    hq.status = 401;
    yield* TestClock.adjust(60_000);
    assert.strictEqual((yield* service.read).status, "invalid_token");
    hq.status = 200;
    yield* TestClock.adjust(60_000);
    assert.strictEqual((yield* service.read).status, "ready");
  }),
);

it.effect("reads Home as HQ actually answers it: an owner card, then a stuck line", () =>
  Effect.gen(function* () {
    const { hq, service } = yield* connected;
    let home: unknown = hqHomeWithOwnerCard;
    hq.answer = (body) =>
      body.action === "home"
        ? { status: 200, json: { status: "succeeded", value: home } }
        : { status: 200, json: { status: "succeeded", value: {} } };
    yield* TestClock.adjust(60_000);
    const withCard = yield* service.read;
    assert.strictEqual(withCard.status, "ready");
    assert.strictEqual(withCard.home?.count, 1);
    const need = withCard.home?.needsYou[0];
    assert.strictEqual(need?.kind, "acceptance");
    if (need?.kind === "acceptance") {
      // The card shows HQ's own checks, so Weave and T3 cannot disagree about them.
      assert.deepStrictEqual(need.checks, hqHomeWithOwnerCard.needsYou[0]?.spec.readiness.checks);
      assert.strictEqual(need.reviewSummary, "Exports now include every row");
      assert.strictEqual(need.tryIt, "https://staging.example/exports");
      assert.deepStrictEqual(need.card, hqHomeWithOwnerCard.needsYou[0]?.spec.card);
    }

    // An HQ from before the checks were projected still shows the card, without checks.
    const [entry] = hqHomeWithOwnerCard.needsYou;
    const { checks: _checks, ...readiness } = entry!.spec.readiness;
    home = {
      ...hqHomeWithOwnerCard,
      needsYou: [{ ...entry, spec: { ...entry!.spec, readiness } }],
    };
    yield* TestClock.adjust(60_000);
    const withoutChecks = (yield* service.read).home?.needsYou[0];
    assert.strictEqual(withoutChecks?.kind, "acceptance");
    if (withoutChecks?.kind === "acceptance") {
      assert.deepStrictEqual(withoutChecks.checks, []);
      assert.deepStrictEqual(withoutChecks.card, entry?.spec.card);
    }

    home = hqHomeWithStuckLine;
    yield* TestClock.adjust(60_000);
    const withStuck = yield* service.read;
    assert.strictEqual(withStuck.home?.count, 1);
    assert.deepStrictEqual(withStuck.home?.needsYou, []);
    assert.strictEqual(withStuck.home?.stuck[0]?.kind, "send_back_undelivered");
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
      body.action === "decide"
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
/** As a T3 lead reports its session to Build: harness `t3code`, its thread id as `sessionRef`. */
const leadRef = { harness: "t3code", sessionRef: leadThread };

it("names the lead's T3 thread from either session form, and nothing else", () => {
  assert.deepStrictEqual(
    BuildHome.leadThreadOf({ harness: "t3code", sessionRef: "mcp:af171d33" }),
    {
      environmentId: null,
      threadId: "mcp:af171d33",
    },
  );
  assert.deepStrictEqual(BuildHome.leadThreadOf({ harness: "t3", sessionRef: "env-1/thread-1" }), {
    environmentId: "env-1",
    threadId: "thread-1",
  });
  // T3 thread ids carry their creation prefix (`mcp:` for a thread an agent launched); it is part of the id.
  assert.deepStrictEqual(
    BuildHome.leadThreadOf({ harness: "t3", sessionRef: "env-1/mcp:af171d33" }),
    { environmentId: "env-1", threadId: "mcp:af171d33" },
  );
  assert.strictEqual(
    BuildHome.leadThreadOf({ harness: "codex-cli", sessionRef: "thread-1" }),
    null,
  );
  assert.strictEqual(BuildHome.leadThreadOf({ harness: "t3code", sessionRef: "a/b/c" }), null);
  assert.strictEqual(BuildHome.leadThreadOf({ harness: "t3code", sessionRef: "" }), null);
});

it.effect("a delivery is reported only to the HQ that recorded the finding", () =>
  Effect.gen(function* () {
    const { hq, world, service, connections } = yield* connected;
    hq.answer = sendBackAnswer(leadRef, 503);
    yield* service.decide(sendBack);
    assert.strictEqual(world.sent.length, 1);
    const before = deliveries(hq).length;
    // Reconnected to another HQ: it never hears of a finding it did not record.
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

      // Still down after a retry, then the process restarts and HQ is back.
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
