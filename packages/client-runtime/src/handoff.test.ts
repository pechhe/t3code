import {
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  handoffCrossesAccounts,
  resolveHandoffEndpoints,
  resolvePendingHandoff,
  type HandoffTimelineRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const projection = {
  thread: { modelSelection: { instanceId: from, model: "source" } },
  runs: [{ ...run("source", 1, from, "source"), startedAt: "2026-10-11T00:00:00Z" }],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [], 0)).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [], 0)?.to.model,
    ).toBe("second");
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [], 0),
    ).toBeNull();
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [], 0),
    ).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [], 0)).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [], 0)?.to.model,
    ).toBe("first");
  });
  it("only previews a same-provider model change when it needs a fresh native thread", () => {
    const providers = [
      { instanceId: from, requiresNewThreadForModelChange: true },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, providers, 0)?.to
        .model,
    ).toBe("other");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers, 0),
    ).toBeNull();
  });
  describe("with an account pool", () => {
    const pool = ProviderInstanceId.make("claude_pooled");
    const yardsmith = ProviderInstanceId.make("claude_yardsmith");
    const hello = ProviderInstanceId.make("claude_hello");
    const account = (instanceId: ProviderInstanceId, usedPercent: number) =>
      ({
        instanceId,
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        continuation: { groupKey: `claude:home:${instanceId}` },
        usageLimits: {
          windows: [{ usedPercent, resetsAt: "2099-01-01T00:00:00Z" }],
        },
      }) as unknown as ServerProvider;
    const onYardsmith = {
      ...projection,
      thread: { modelSelection: { instanceId: yardsmith, model: "sonnet" } },
      runs: [{ ...run("source", 1, yardsmith, "sonnet"), startedAt: "2026-10-11T00:00:00Z" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const providers = (yardsmithUsed: number) => [
      account(yardsmith, yardsmithUsed),
      account(hello, 0),
      { ...account(yardsmith, 0), instanceId: pool, poolMembers: [hello, yardsmith] },
    ];

    it("stays quiet when the pool keeps the thread on its account", () => {
      expect(
        resolvePendingHandoff(onYardsmith, { instanceId: pool, model: "opus" }, providers(50), 0),
      ).toBeNull();
    });

    it("names the account the pool will move the thread to", () => {
      expect(
        resolvePendingHandoff(onYardsmith, { instanceId: pool, model: "opus" }, providers(100), 0),
      ).toEqual({
        from: [{ instanceId: yardsmith, model: "sonnet" }],
        to: { instanceId: hello, model: "opus" },
      });
    });

    it("routes from the account the thread is on, not its last run", () => {
      const movedToHello = {
        ...onYardsmith,
        thread: { modelSelection: { instanceId: hello, model: "sonnet" } },
      } as unknown as OrchestrationV2ThreadProjection;
      expect(
        resolvePendingHandoff(movedToHello, { instanceId: pool, model: "opus" }, providers(0), 0)
          ?.to.instanceId,
      ).toBe(hello);
    });

    it("labels accounts only when a handoff stays with the same provider", () => {
      const endpoints = {
        from: [{ instanceId: yardsmith }],
        to: { instanceId: hello, model: undefined },
      };
      expect(handoffCrossesAccounts(endpoints, providers(0))).toBe(true);
      expect(
        handoffCrossesAccounts(
          { ...endpoints, to: { instanceId: from, model: undefined } },
          providers(0),
        ),
      ).toBe(false);
    });
  });
});
