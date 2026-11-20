import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId, type ChampionSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerEnvironments from "../peers/PeerEnvironments.ts";
import * as Champions from "./ChampionService.ts";
import { ChampionDirectoryResult, listAcross } from "./ChampionDirectory.ts";

const decodeDirectory = Schema.decodeUnknownSync(ChampionDirectoryResult);
const local = EnvironmentId.make("mac");
const box = EnvironmentId.make("box");
const offline = EnvironmentId.make("offline");
const summary: ChampionSummary = {
  id: "c",
  projectId: ProjectId.make("p"),
  name: "Performance",
  purpose: "Stay fast",
  schedule: { type: "interval", everyMs: 3600000 },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "active",
  ownerThreadId: ThreadId.make("owner"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: null,
  outstandingCheckId: null,
  attention: [],
  openFindingCount: 0,
  updatedAt: "2026-11-07T00:00:00.000Z",
};

it.effect(
  "lists each machine once and reports an unreachable peer without failing the local list",
  () => {
    const calls: Array<unknown> = [];
    let compactPeer = false;
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: local,
      thread: undefined,
      client: undefined,
      issuedAt: 0,
      requestNamespace: "test",
      capabilities: new Set(["orchestration"]),
    };
    return Effect.gen(function* () {
      const result = yield* listAcross({ projectId: summary.projectId });
      expect(result.champions).toMatchObject([
        { id: "c", environmentId: local },
        { id: "c", environmentId: box, environmentLabel: "Box" },
      ]);
      for (const champion of result.champions) {
        expect(champion).not.toHaveProperty("charter");
        expect(champion).not.toHaveProperty("latestSamples");
      }
      expect("environments" in result && result.environments).toMatchObject([
        { environmentId: box, status: "ok" },
        { environmentId: offline, status: "offline" },
      ]);
      expect(calls).toEqual([
        { environmentId: box, name: "t3_champions_list", arguments: { environmentId: box } },
        {
          environmentId: offline,
          name: "t3_champions_list",
          arguments: { environmentId: offline },
        },
      ]);
      compactPeer = true;
      expect(yield* listAcross({ projectId: summary.projectId })).toEqual(result);
      calls.length = 0;
      expect(yield* listAcross({ environmentId: local })).toMatchObject({
        champions: [{ id: summary.id, lifecycle: summary.lifecycle }],
      });
      expect(calls).toEqual([]);
      yield* listAcross({}).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          client: { sessionId: "link", label: "source", access: "full-access", linked: true },
        }),
      );
      expect(calls).toEqual([]);
      const fullCalls: Array<unknown> = [];
      const fullResult = yield* listAcross({}).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(PeerLinks.PeerLinks)({
              list: Effect.succeed([
                {
                  environmentId: box,
                  label: "Full Box",
                  urls: ["https://box.invalid"],
                  access: "full-access",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1_000_000),
                  lastReachedAt: null,
                  lastError: null,
                  status: "reachable",
                },
              ]),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (input) =>
                Effect.sync(() => {
                  fullCalls.push(input.environmentId);
                  return decodeDirectory({
                    champions: [summary],
                  }) as never;
                }),
            }),
          ),
        ),
      );
      expect(fullResult.champions).toHaveLength(2);
      expect(fullResult.champions[1]).toMatchObject({
        environmentId: box,
        environmentLabel: "Full Box",
      });
      expect(fullCalls).toEqual([box]);
      expect(calls).toEqual([
        {
          environmentId: offline,
          name: "t3_champions_list",
          arguments: { environmentId: offline },
        },
      ]);
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Champions.ChampionService)({
            list: () => Effect.succeed({ champions: [summary] }),
          }),
          Layer.mock(PeerEnvironments.PeerEnvironments)({
            linked: Effect.succeed([
              { environmentId: box, label: "Box" },
              { environmentId: offline, label: "Offline" },
            ]),
            callTool: (input) => {
              calls.push(input);
              return input.environmentId === offline
                ? Effect.fail(
                    new PeerEnvironments.PeerCallError({
                      environmentId: offline,
                      status: "offline",
                    }),
                  )
                : Effect.succeed({
                    isError: false,
                    structuredContent: compactPeer
                      ? decodeDirectory({ champions: [summary] })
                      : { champions: [summary] },
                    text: "",
                  });
            },
          }),
        ),
      ),
    );
  },
);

it.effect("keeps a dozen long Champion configurations out of the list result", () => {
  const champions = Array.from({ length: 12 }, (_, index) => ({
    ...summary,
    id: `champion:${index}`,
    charter: { ...summary.charter, instructions: "Measure responsiveness. ".repeat(300) },
    latestSamples: Array.from({ length: 16 }, (_, metric) => ({
      metricId: `metric:${metric}`,
      name: "Response latency",
      version: 1,
      seriesId: "latency",
      unit: "ms",
      required: true,
      value: 100,
      status: "measured" as const,
      health: "healthy" as const,
      observedAt: summary.updatedAt,
      collectedAt: summary.updatedAt,
      revision: "a".repeat(40),
      staleAt: null,
    })),
  }));
  return Effect.gen(function* () {
    const result = yield* listAcross({ environmentId: local });
    expect(result.champions).toHaveLength(12);
    expect(result.champions[0]).toEqual({
      id: "champion:0",
      projectId: summary.projectId,
      name: summary.name,
      purpose: summary.purpose,
      lifecycle: summary.lifecycle,
      ownerThreadId: summary.ownerThreadId,
      nextCheckAt: null,
      lastCheckAt: null,
      attention: [],
      openFindingCount: 0,
      updatedAt: summary.updatedAt,
    });
    expect(JSON.stringify(result).length).toBeLessThan(5_000);
    expect(JSON.stringify({ champions }).length).toBeGreaterThan(150_000);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: local,
      thread: undefined,
      client: undefined,
      issuedAt: 0,
      requestNamespace: "test",
      capabilities: new Set(["orchestration"] as const),
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(Champions.ChampionService)({
          list: () => Effect.succeed({ champions }),
        }),
      ),
    ),
  );
});
