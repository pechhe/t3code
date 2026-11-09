import { expect, it } from "@effect/vitest";
import {
  type ChampionLearningContributor,
  type ChampionLearningRevision,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as Champions from "../../../champions/ChampionService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ChampionsHandlers from "./handlers.ts";
import { ChampionsToolkit } from "./tools.ts";

const here = EnvironmentId.make("peach-live");
const box = EnvironmentId.make("peach-box");
const leadThread = ThreadId.make("thread:lead");
const workerThread = ThreadId.make("thread:worker");
const otherThread = ThreadId.make("thread:other");
const deepThread = ThreadId.make("thread:deep");

const shells = new Map([
  [
    leadThread,
    { ...liveThreadShell(leadThread), title: "Spec lead", agentTask: { role: "lead" } as never },
  ],
  [
    workerThread,
    { ...liveThreadShell(workerThread), agentTask: { role: "implementation-worker" } as never },
  ],
  [otherThread, { ...liveThreadShell(otherThread), title: "Other" }],
  [
    deepThread,
    {
      ...liveThreadShell(deepThread),
      agentTask: { role: "implementation-worker" } as never,
      lineage: { parentThreadId: workerThread, relationshipToParent: "subagent" } as never,
    },
  ],
]);
shells.set(workerThread, {
  ...shells.get(workerThread)!,
  lineage: { parentThreadId: otherThread, relationshipToParent: "subagent" } as never,
});

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: here,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

/** How a peer link reaches this environment: the read-only `peer-threads` credential. */
const linkScope: McpInvocationContext.McpInvocationScope = {
  environmentId: box,
  requestNamespace: "client:link",
  thread: undefined,
  client: { sessionId: "link", label: "peach-live", access: "peer-threads", linked: true },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const learning = {
  id: "champion:gate",
  learningId: "learning:prefetch",
  expectedCurrentId: null,
  reason: "Observed",
  topic: "latency",
  plainSummary: "Warming the cache first makes the first screen quicker.",
  question: "What speeds up cold start?",
  conclusion: "Prefetching the manifest halves cold start.",
  attempts: [],
  evidence: [
    {
      source: "trace",
      evidence: "Cold start 2.1 s → 1.0 s",
      observedAt: "2026-11-07T00:00:00.000Z",
    },
  ],
  components: [],
  environment: "peach-box",
  applicability: "Web client",
  tradeoffs: "None seen",
  reviewAt: "2027-01-01T00:00:00.000Z",
  reviewConditions: [],
  versionConditions: [],
};

const harness = Effect.sync(() => {
  const contributed: Array<ChampionLearningContributor> = [];
  const recorded: Array<unknown> = [];
  const forwarded: Array<{ environmentId: string; tool: string; params: unknown }> = [];
  const searched: Array<unknown> = [];
  const queried: Array<unknown> = [];
  const findingActions: Array<unknown> = [];
  const deliveries: Array<unknown> = [];
  const revision = (input: { readonly id: string }) =>
    ({
      ...input,
      id: "revision:1",
      championId: input.id,
      projectId: "project:box",
      recordedAt: "2026-11-07T00:00:00.000Z",
      supersedes: null,
      applicabilityState: "current",
      isCurrent: true,
    }) as unknown as ChampionLearningRevision;
  const service = Layer.mock(Champions.ChampionService)({
    // The lead thread owns this champion; every other caller contributes.
    get: () => Effect.succeed({ champion: { ownerThreadId: leadThread } } as unknown as never),
    recordLearning: (_caller, input) =>
      Effect.sync(() => {
        recorded.push(input);
        return revision(input);
      }),
    contributeLearning: (contributor, input) =>
      Effect.sync(() => {
        contributed.push(contributor);
        return { ...revision(input), contribution: contributor };
      }),
    learningSearch: (input) =>
      Effect.sync(() => {
        searched.push(input);
        return { learnings: [], total: 0, nextCursor: null };
      }),
    learningQuery: (input) =>
      Effect.sync(() => {
        queried.push(input);
        return {
          revisions: [],
          nextCursor: null,
          receiptId: "receipt:1",
          retrievedAt: "2026-11-07T00:00:00.000Z",
        };
      }),
    findingAction: (input, approval) =>
      Effect.sync(() => {
        findingActions.push({ input, approval });
        return {} as never;
      }),
    updateDelivery: (_caller, input) =>
      Effect.sync(() => {
        deliveries.push(input);
        return {} as never;
      }),
    runtimeState: () => Effect.succeed({ attempts: [], investigations: [], recommendations: [] }),
  });
  const forwarding = Layer.mock(PeerForwarding.PeerForwarding)({
    call: (_scope, tool, environmentId, params) =>
      Effect.sync(() => {
        forwarded.push({ environmentId, tool: tool.name, params });
        return { forwarded: true } as never;
      }),
  });
  const layer = McpHttpServer.toolkitRegistration(ChampionsToolkit, ChampionsHandlers.layer).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      }),
    ),
    Layer.provideMerge(service),
    Layer.provideMerge(forwarding),
  );
  return {
    contributed,
    recorded,
    forwarded,
    searched,
    queried,
    findingActions,
    deliveries,
    layer,
  };
});

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

it.effect(
  "a linked environment reads learnings and passes on an orchestrating thread's contribution, and nothing else",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const search = yield* call("t3_champions_learning_search", linkScope, {
          action: "search",
          query: "manifest",
        });
        expect(search.isError).toBe(false);
        expect(h.searched).toEqual([{ query: "manifest" }]);

        const refusedWrite = yield* call("t3_champions_control", linkScope, {
          action: "run_check",
          id: "champion:gate",
        });
        expect(refusedWrite.isError).toBe(true);
        expect(refusedWrite.text).toContain("capability_denied");
        // Peers keep the same abilities they had: a plain search only, never the
        // receipt-retaining lookup, and no runtime state through get.
        const refusedReceipt = yield* call("t3_champions_learning_search", linkScope, {
          action: "query",
          id: "champion:gate",
          topic: "latency",
        });
        expect(refusedReceipt.text).toContain("capability_denied");
        expect(h.queried).toEqual([]);
        const refusedInclude = yield* call("t3_champions_get", linkScope, {
          id: "champion:gate",
          include: "runtime_state",
        });
        expect(refusedInclude.text).toContain("capability_denied");

        // A link must name the thread it authenticated.
        const bare = yield* call("t3_champions_record_learning", linkScope, learning);
        expect(bare.text).toContain("capability_denied");
        const fromLead = yield* call("t3_champions_record_learning", linkScope, {
          ...learning,
          forwardedFrom: {
            environmentId: here,
            threadId: leadThread,
            threadTitle: "Spec lead",
            role: "lead",
          },
        });
        expect(fromLead.isError).toBe(false);
        expect(h.contributed).toEqual([
          {
            environmentId: here,
            threadId: leadThread,
            threadTitle: "Spec lead",
            role: "lead",
            environmentLabel: "peach-live",
            linkSessionId: "link",
          },
        ]);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("a lead and a delegated worker forward a contribution with their own identity", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const worker = yield* call("t3_champions_record_learning", threadScope(workerThread), {
        ...learning,
        environmentId: box,
      });
      expect(worker.text).not.toContain("capability_denied");
      expect(h.forwarded).toHaveLength(1);

      // A model cannot claim to be another thread.
      const spoofed = yield* call("t3_champions_record_learning", threadScope(leadThread), {
        ...learning,
        environmentId: box,
        forwardedFrom: {
          environmentId: here,
          threadId: "thread:other",
          threadTitle: null,
          role: "lead",
        },
      });
      expect(spoofed.text).toContain("invalid_request");

      yield* call("t3_champions_record_learning", threadScope(leadThread), {
        ...learning,
        environmentId: box,
      });
      expect(h.forwarded.slice(1)).toEqual([
        {
          environmentId: box,
          tool: "t3_champions_record_learning",
          params: expect.objectContaining({
            environmentId: box,
            forwardedFrom: {
              environmentId: here,
              threadId: leadThread,
              threadTitle: "Spec lead",
              role: "lead",
            },
          }),
        },
      ]);

      yield* call("t3_champions_learning_search", threadScope(workerThread), {
        action: "search",
        query: "manifest",
        environmentId: box,
      });
      expect(h.forwarded.at(-1)).toMatchObject({
        environmentId: box,
        tool: "t3_champions_learning_search",
      });
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("the owner records its own learning and any other orchestrating thread contributes", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      // A delegated worker retains the receipt that admits an investigation, as any editor does.
      const workerQuery = yield* call("t3_champions_learning_search", threadScope(workerThread), {
        action: "query",
        id: "champion:gate",
        topic: "latency",
      });
      expect(workerQuery.text).not.toContain("capability_denied");
      expect(h.queried).toHaveLength(1);

      // A plain search keeps its limit of 50; only the query action is capped at 20.
      const wide = yield* call("t3_champions_learning_search", threadScope(workerThread), {
        limit: 50,
      });
      expect(wide.isError).toBe(false);
      const wideQuery = yield* call("t3_champions_learning_search", threadScope(leadThread), {
        action: "query",
        id: "champion:gate",
        topic: "latency",
        limit: 21,
      });
      expect(wideQuery.text).toContain("invalid_request");
      expect(h.queried).toHaveLength(1);

      // A plain search writes nothing; only the query action retains a receipt.
      yield* call("t3_champions_learning_search", threadScope(leadThread), {
        action: "search",
        query: "manifest",
      });
      expect(h.queried).toHaveLength(1);
      yield* call("t3_champions_learning_search", threadScope(leadThread), {
        action: "query",
        id: "champion:gate",
        topic: "latency",
      });
      expect(h.queried.at(-1)).toEqual(
        expect.objectContaining({ id: "champion:gate", topic: "latency" }),
      );

      // get can fold in runtime state for a local caller.
      const runtime = yield* call("t3_champions_get", threadScope(leadThread), {
        id: "champion:gate",
        include: "runtime_state",
      });
      expect(runtime.isError).toBe(false);

      const owner = yield* call("t3_champions_record_learning", threadScope(leadThread), learning);
      expect(owner.isError).toBe(false);
      expect(h.recorded).toHaveLength(1);
      expect(h.contributed).toEqual([]);

      const contributor = yield* call("t3_champions_record_learning", threadScope(otherThread), {
        ...learning,
        learningId: "learning:other",
      });
      expect(contributor.isError).toBe(false);
      expect(h.recorded).toHaveLength(1);
      expect(h.contributed).toEqual([
        expect.objectContaining({ threadId: otherThread, threadTitle: "Other" }),
      ]);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect(
  "finding_action guards each action by its own rule and names the caller for approval",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        expect(h.deliveries).toEqual([]);

        yield* call("t3_champions_finding_action", threadScope(leadThread), {
          action: "resolve_decision",
          id: "champion:gate",
          findingId: "finding:1",
          decisionId: "decision:1",
          reason: "Yes",
          approvalQuote: "yes do it",
        });
        expect(h.findingActions).toEqual([
          {
            input: expect.objectContaining({
              action: "resolve_decision",
              decisionId: "decision:1",
            }),
            approval: { threadId: leadThread, quote: "yes do it" },
          },
        ]);

        yield* call("t3_champions_finding_action", threadScope(leadThread), {
          action: "delivered",
          findingId: "finding:1",
          evidence: "Landed",
        });
        expect(h.deliveries).toEqual([
          expect.objectContaining({ action: "delivered", evidence: "Landed" }),
        ]);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect("a Champion check or setup from a thread at the delegation limit is refused", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      for (const action of ["run_check", "setup"]) {
        const refused = yield* call("t3_champions_control", threadScope(deepThread), {
          action,
          id: "champion:gate",
        });
        expect(refused.text).toContain("delegation limit");
      }
    }).pipe(Effect.provide(h.layer));
  }),
);
