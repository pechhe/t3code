import {
  WS_METHODS,
  type BuildWorkItemSummary,
  type BuildWorkItemView,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * A thread's linked Build item. The server reads Build at most once a minute per item, so
 * refreshing on that cadence while shown keeps it current and costs nothing once hidden.
 */
export function createBuildWorkItemAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    item: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:work-item",
      tag: WS_METHODS.buildWorkItemRead,
      staleTimeMs: 60_000,
      refreshIntervalMs: 60_000,
    }),
    connection: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:build:connection",
      tag: WS_METHODS.buildConnectionRead,
      staleTimeMs: 60_000,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:build:work-item:link",
      tag: WS_METHODS.buildWorkItemLink,
    }),
  };
}

export type BuildStatusTone =
  | "not-started"
  | "in-progress"
  | "landed"
  | "accepted"
  | "dropped"
  | "unknown";

export function buildStatusTone(item: BuildWorkItemSummary | null): BuildStatusTone {
  switch (item?.status) {
    case "inbox":
    case "shaping":
    case "ready":
      return "not-started";
    case "in_progress":
      return "in-progress";
    case "landed":
      return "landed";
    case "accepted":
      return "accepted";
    case "dropped":
      return "dropped";
    case undefined:
      return "unknown";
  }
}

export const BUILD_STATUS_LABELS: Record<BuildWorkItemSummary["status"], string> = {
  inbox: "Inbox",
  shaping: "Shaping",
  ready: "Ready",
  in_progress: "In progress",
  landed: "Landed",
  accepted: "Accepted",
  dropped: "Dropped",
};

export const buildKindGlyph = (kind: BuildWorkItemSummary["kind"] | undefined) =>
  kind === "ticket" ? "▢" : "◇";

/** What a header segment or subtitle shows for a linked item, on web and mobile alike. */
export function presentBuildWorkItem(link: BuildWorkItemView) {
  const item = link.item;
  return {
    glyph: buildKindGlyph(item?.kind),
    // With nothing read yet, the number is all that is known; never a spinner.
    title: item?.title ?? `Build ${link.number}`,
    tone: buildStatusTone(item),
    statusLabel: item === null ? null : BUILD_STATUS_LABELS[item.status],
    held: (item?.holds.length ?? 0) > 0,
    blocked: (item?.waits.length ?? 0) > 0,
    unavailable: link.unavailable,
  };
}
export type BuildWorkItemPresentation = ReturnType<typeof presentBuildWorkItem>;
