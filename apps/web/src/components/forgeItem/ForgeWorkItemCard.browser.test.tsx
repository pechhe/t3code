import type { ForgeWorkItemCard as ForgeWorkItemCardData } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";

import { ForgeWorkItemCard } from "./ForgeWorkItemCard";

const read = {
  number: 5_162,
  url: "https://weave.example/forge/5162",
  summary: "Get substantially more useful engineering outcomes from our setup.",
  updatedAt: "2026-10-25T12:00:00.000Z",
  readAt: "2026-10-25T12:00:00.000Z",
  unavailable: false,
};

const arcCard: ForgeWorkItemCardData = {
  ...read,
  item: {
    kind: "arc",
    ref: "YS-ARC-01",
    title: "Get the most out of our agentic engineering setup",
    status: "open",
    holds: [],
    waits: [],
  },
  detail: { kind: "arc" },
};

const specCard: ForgeWorkItemCardData = {
  ...read,
  item: {
    kind: "spec",
    ref: "YS-471",
    title: "Give Arcs friendly refs",
    status: "ready",
    holds: [],
    waits: [],
  },
  detail: {
    kind: "spec",
    specKind: "feature",
    horizon: "next",
    ticketCounts: {},
    tickets: [],
    acceptedAt: null,
    governedBy: [],
    lead: null,
  },
};

describe("ForgeWorkItemCard", () => {
  it("shows an Arc's own ref, full title and status, never a Spec's", async () => {
    // The card renders no links for an Arc, so it needs no route.
    await using screen = await render(<ForgeWorkItemCard card={arcCard} />, { router: false });

    await expect.element(screen.getByText("◈ Arc")).toBeVisible();
    await expect.element(screen.getByText("YS-ARC-01")).toBeVisible();
    await expect.element(screen.getByText("Open")).toBeVisible();
    expect(screen.container.textContent).toContain(
      "Get the most out of our agentic engineering setup",
    );
    expect(screen.container.textContent).toContain(
      "Get substantially more useful engineering outcomes from our setup.",
    );
    const shown = screen.container.textContent ?? "";
    expect(shown).not.toContain("No lead thread");
    expect(shown).not.toContain("No thread working on it");
    expect(shown).not.toContain("Spec");
    expect(shown).not.toContain("Ticket");
  });

  it("still names a Spec with its kind and the thread leading it", async () => {
    await using screen = await render(<ForgeWorkItemCard card={specCard} />, { router: false });

    await expect.element(screen.getByText("◇ Spec · feature · next")).toBeVisible();
    await expect.element(screen.getByText("No lead thread")).toBeVisible();
  });
});
