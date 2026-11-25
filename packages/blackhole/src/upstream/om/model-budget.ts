// @ts-nocheck -- vendored pi-blackhole source, type-checked upstream under its own settings.
// T3 replacement for upstream's model-budget.ts: only the worker output bound the agents import.
import type { Model } from "../../shims/pi-ai.ts";

export const AGENT_LOOP_MAX_TOKENS = 32_000;

export function boundedMaxTokens(
  model: Model<any>,
  requested: number = AGENT_LOOP_MAX_TOKENS,
): number {
  return typeof model.maxTokens === "number" && model.maxTokens > 0
    ? Math.min(model.maxTokens, requested)
    : requested;
}
