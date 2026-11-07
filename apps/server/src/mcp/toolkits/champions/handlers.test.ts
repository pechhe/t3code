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

const shells = new Map([
  [
    leadThread,
    { ...liveThreadShell(leadThread), title: "Spec lead", agentTask: { role: "lead" } as never },
  ],
  [
    workerThread,
    { ...liveThreadShell(workerThread), agentTask: { role: "implementation-worker" } as never },
  ],
]);

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
  const forwarded: Array<{ environmentId: string; tool: string; params: unknown }> = [];
  const searched: Array<unknown> = [];
  const service = Layer.mock(Champions.ChampionService)({
    learningSearch: (input) =>
      Effect.sync(() => {
        searched.push(input);
        return { learnings: [], total: 0, nextCursor: null };
      }),
    contributeLearning: (contributor, input) =>
      Effect.sync(() => {
        contributed.push(contributor);
        return {
          ...input,
          id: "revision:1",
          championId: input.id,
          projectId: "project:box",
          recordedAt: "2026-11-07T00:00:00.000Z",
          supersedes: null,
          applicabilityState: "current",
          isCurrent: true,
          contribution: contributor,
        } as unknown as ChampionLearningRevision;
      }),
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
  return { contributed, forwarded, searched, layer };
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
          query: "manifest",
        });
        expect(search.isError).toBe(false);
        expect(h.searched).toEqual([{ query: "manifest" }]);

        const refusedWrite = yield* call("t3_champions_run_check", linkScope, {
          id: "champion:gate",
        });
        expect(refusedWrite.isError).toBe(true);
        expect(refusedWrite.text).toContain("capability_denied");
        const refusedReceipt = yield* call("t3_champions_learning_query", linkScope, {
          id: "champion:gate",
          topic: "latency",
        });
        expect(refusedReceipt.text).toContain("capability_denied");

        // A link must name the thread it authenticated, and never a worker.
        const bare = yield* call("t3_champions_contribute_learning", linkScope, learning);
        expect(bare.text).toContain("capability_denied");
        const fromWorker = yield* call("t3_champions_contribute_learning", linkScope, {
          ...learning,
          forwardedFrom: {
            environmentId: here,
            threadId: workerThread,
            threadTitle: null,
            role: "implementation-worker",
          },
        });
        expect(fromWorker.text).toContain("capability_denied");
        const fromLead = yield* call("t3_champions_contribute_learning", linkScope, {
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

it.effect(
  "a lead forwards its contribution with its own identity, and a delegated worker is refused before anything leaves",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Effect.gen(function* () {
        const worker = yield* call("t3_champions_contribute_learning", threadScope(workerThread), {
          ...learning,
          environmentId: box,
        });
        expect(worker.text).toContain("capability_denied");
        expect(h.forwarded).toEqual([]);

        // A model cannot claim to be another thread.
        const spoofed = yield* call("t3_champions_contribute_learning", threadScope(leadThread), {
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

        yield* call("t3_champions_contribute_learning", threadScope(leadThread), {
          ...learning,
          environmentId: box,
        });
        expect(h.forwarded).toEqual([
          {
            environmentId: box,
            tool: "t3_champions_contribute_learning",
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
