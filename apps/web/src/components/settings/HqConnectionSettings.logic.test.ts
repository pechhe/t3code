import { describe, expect, it } from "vite-plus/test";

import { describeHqConnection, handbackOriginOf } from "./HqConnectionSettings.logic";

describe("describeHqConnection", () => {
  it("keeps an existing connection visible when a new sign-in is cancelled", () => {
    const view = describeHqConnection({
      connected: true,
      origin: "https://hq.example.test",
      signIn: { status: "cancelled" },
    });
    expect(view.connected).toBe(true);
    expect(view.description).toContain("https://hq.example.test");
    expect(view.description).toContain("existing connection is unchanged");
  });

  it("explains why a sign-in failed", () => {
    const view = describeHqConnection({
      connected: false,
      origin: null,
      signIn: { status: "failed", reason: "no_access" },
    });
    expect(view.connected).toBe(false);
    expect(view.description).toContain("no longer has access");
  });

  it("shows waiting only while HQ's page is open", () => {
    expect(
      describeHqConnection({ connected: false, origin: null, signIn: { status: "pending" } })
        .waiting,
    ).toBe(true);
    expect(
      describeHqConnection({ connected: true, origin: "https://hq.example.test" }).waiting,
    ).toBe(false);
  });
});

describe("a connection HQ refuses", () => {
  it("is not shown as simply connected", () => {
    const view = describeHqConnection({
      connected: true,
      origin: "https://hq.example.test",
      refused: true,
    });
    expect(view.refused).toBe(true);
    expect(view.description).toContain("no longer accepts");
  });
});

describe("handbackOriginOf", () => {
  it("is the origin a client reaches the environment through, without path or query", () => {
    expect(handbackOriginOf("https://t3.example.test:8443/base?x=1")).toBe(
      "https://t3.example.test:8443",
    );
    expect(handbackOriginOf("not a url")).toBeNull();
  });
});
