import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { claudeRequestUsage, normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  codexRequestUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";
import {
  addTurnRequestUsage,
  makeTurnUsageBuffer,
  settleTurnUsage,
  type TurnUsageIdentity,
} from "./TurnUsageRecords.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });
});

describe("the usage rows a turn owes Weave", () => {
  const identity: TurnUsageIdentity = {
    threadId: ThreadId.make("thread-lead"),
    provider: "claude",
    providerThreadId: "provider-thread-1",
    turnId: "turn-1",
    modelRef: "claude-sonnet-4-6",
    startedAt: 1_000,
    endedAt: 9_000,
    runId: "run-1",
  };

  /** The turn figure T3 shows: its input folds cache reads and writes in. */
  const turnUsage = (
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens = 0,
    cacheCreationTokens?: number,
  ) => ({
    usageScope: "main_agent" as const,
    usageStatus: "complete" as const,
    hasSubagents: false,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
  });

  const claudeMessage = (
    messageId: string,
    usage: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    },
  ) =>
    claudeRequestUsage({
      providerThreadId: "provider-thread-1",
      messageId,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(usage.cacheRead === undefined ? {} : { cache_read_input_tokens: usage.cacheRead }),
        ...(usage.cacheWrite === undefined
          ? {}
          : { cache_creation_input_tokens: usage.cacheWrite }),
      },
      modelRef: "claude-sonnet-4-6",
      startedAt: 1_000,
      endedAt: 2_000,
    })!;

  it("keeps one row for a message whose snapshots repeat its usage", () => {
    const buffer = makeTurnUsageBuffer();
    addTurnRequestUsage(buffer, claudeMessage("msg-1", { input: 12, output: 3, cacheRead: 400 }));
    // Every snapshot of one message reports the same usage again.
    addTurnRequestUsage(buffer, claudeMessage("msg-1", { input: 12, output: 3, cacheRead: 400 }));

    const rows = settleTurnUsage(buffer, turnUsage(412, 3, 400), identity);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      threadId: identity.threadId,
      usageRef: "claude:provider-thread-1:msg-1",
      level: "request",
      tokens: { input: 12, output: 3, cacheRead: 400 },
      startedAt: 1_000,
      endedAt: 2_000,
      modelRef: "claude-sonnet-4-6",
      runId: "run-1",
    });
  });

  it("keeps each request's cache reads and writes apart from its input", () => {
    const buffer = makeTurnUsageBuffer();
    addTurnRequestUsage(
      buffer,
      claudeMessage("msg-1", { input: 10, output: 2, cacheRead: 100, cacheWrite: 50 }),
    );
    addTurnRequestUsage(buffer, claudeMessage("msg-2", { input: 20, output: 4, cacheRead: 200 }));

    const rows = settleTurnUsage(buffer, turnUsage(380, 6, 300, 50), identity);

    expect(rows.map((row) => [row.usageRef, row.level, row.tokens])).toEqual([
      [
        "claude:provider-thread-1:msg-1",
        "request",
        { input: 10, output: 2, cacheRead: 100, cacheWrite: 50 },
      ],
      ["claude:provider-thread-1:msg-2", "request", { input: 20, output: 4, cacheRead: 200 }],
    ]);
  });

  it("records the turn alone when its requests do not add up to its own figure", () => {
    const buffer = makeTurnUsageBuffer();
    addTurnRequestUsage(buffer, claudeMessage("msg-1", { input: 10, output: 2, cacheRead: 100 }));

    const rows = settleTurnUsage(buffer, turnUsage(500, 2, 100), identity);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      threadId: identity.threadId,
      usageRef: "claude:provider-thread-1:turn-1",
      level: "turn",
      tokens: { input: 400, output: 2, cacheRead: 100 },
      startedAt: 1_000,
      endedAt: 9_000,
      modelRef: "claude-sonnet-4-6",
      runId: "run-1",
    });
  });

  it("records the turn alone when a request had no id to key it by", () => {
    const buffer = makeTurnUsageBuffer();
    addTurnRequestUsage(buffer, {
      ...claudeMessage("msg-1", { input: 10, output: 2 }),
      usageRef: null,
    });

    expect(settleTurnUsage(buffer, turnUsage(10, 2), identity)).toEqual([
      expect.objectContaining({ usageRef: "claude:provider-thread-1:turn-1", level: "turn" }),
    ]);
  });

  it("records nothing when the turn measured no tokens", () => {
    const buffer = makeTurnUsageBuffer();
    addTurnRequestUsage(buffer, claudeMessage("msg-1", { input: 10, output: 2 }));

    expect(settleTurnUsage(buffer, undefined, identity)).toEqual([
      expect.objectContaining({ level: "turn", tokens: null }),
    ]);
    expect(
      settleTurnUsage(
        buffer,
        { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
        identity,
      )[0]?.tokens,
    ).toBeNull();
  });

  it("records nothing when the turn reports zero tokens, rather than a measured zero", () => {
    const buffer = makeTurnUsageBuffer();

    expect(settleTurnUsage(buffer, turnUsage(0, 0), identity)).toEqual([
      expect.objectContaining({ level: "turn", tokens: null }),
    ]);
  });

  it("keys each Codex response by the thread's running total, so a replayed update counts once", () => {
    const buffer = makeTurnUsageBuffer();
    const update = (params: {
      readonly input: number;
      readonly cached: number;
      readonly output: number;
      readonly lastInput: number;
      readonly lastCached: number;
      readonly lastOutput: number;
    }) => ({
      total: {
        totalTokens: params.input + params.output,
        inputTokens: params.input,
        cachedInputTokens: params.cached,
        outputTokens: params.output,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: params.lastInput + params.lastOutput,
        inputTokens: params.lastInput,
        cachedInputTokens: params.lastCached,
        outputTokens: params.lastOutput,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    });
    const response = (tokenUsage: ReturnType<typeof update>) =>
      codexRequestUsage({
        providerThreadId: "provider-thread-1",
        turnId: "turn-1",
        tokenUsage,
        modelRef: "gpt-5.5",
        startedAt: 1_000,
        endedAt: 2_000,
      })!;
    const first = response(
      update({
        input: 1_010,
        cached: 505,
        output: 102,
        lastInput: 10,
        lastCached: 5,
        lastOutput: 2,
      }),
    );
    addTurnRequestUsage(buffer, first);
    // A replay of one notification carries the same running total.
    addTurnRequestUsage(
      buffer,
      response(
        update({
          input: 1_010,
          cached: 505,
          output: 102,
          lastInput: 10,
          lastCached: 5,
          lastOutput: 2,
        }),
      ),
    );
    addTurnRequestUsage(
      buffer,
      response(
        update({
          input: 1_030,
          cached: 515,
          output: 108,
          lastInput: 20,
          lastCached: 10,
          lastOutput: 6,
        }),
      ),
    );

    expect(first.usageRef).toBe("codex:provider-thread-1:turn-1:1010/102");
    expect(first.tokens).toEqual({ input: 5, output: 2, cacheRead: 5 });
    expect(buffer.requests).toHaveLength(2);
  });
});
