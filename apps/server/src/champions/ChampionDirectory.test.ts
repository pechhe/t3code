import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerEnvironments from "../peers/PeerEnvironments.ts";
import * as Champions from "./ChampionService.ts";
import { listAcross } from "./ChampionDirectory.ts";

const local = EnvironmentId.make("mac");
const box = EnvironmentId.make("box");
const offline = EnvironmentId.make("offline");
const summary: ChampionSummary = {
  id: "c",
  projectId: ProjectId.make("p"),
  name: "Performance",
  purpose: "Stay fast",
  schedule: { type: "interval", everyMs: 3600000 },
  setupModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
  routineModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "active",
  ownerThreadId: ThreadId.make("owner"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: null,
  outstandingCheckId: null,
  attention: [],
  openFindingCount: 0,
  pendingProposal: false,
  updatedAt: "2026-11-07T00:00:00.000Z",
};

it.effect(
  "lists each machine once and reports an unreachable peer without failing the local list",
  () => {
    const calls: Array<unknown> = [];
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
      calls.length = 0;
      expect(yield* listAcross({ environmentId: local })).toEqual({ champions: [summary] });
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
                  return { champions: [summary] } as never;
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
                    structuredContent: { champions: [summary] },
                    text: "",
                  });
            },
          }),
        ),
      ),
    );
  },
);
