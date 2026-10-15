import { EnvironmentId, type PeersUpdateInput } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "../connection/model.ts";
import {
  linkPeerEnvironments,
  peerLinkAvailability,
  peerLinkSubtitle,
  peerRoutesFor,
  unlinkPeerEnvironments,
  unreadableThreadRefs,
} from "./peers.ts";

const MAC = EnvironmentId.make("environment-mac");
const VPS = EnvironmentId.make("environment-vps");

function directEntry(environmentId: EnvironmentId, httpBaseUrl: string): ConnectionCatalogEntry {
  return {
    target: new BearerConnectionTarget({ environmentId, label: "Env", connectionId: "c" }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "c",
        environmentId,
        label: "Env",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
    enabled: true,
  };
}

describe("peerRoutesFor", () => {
  it("passes on addresses another server can dial, never loopback", () => {
    expect(
      peerRoutesFor(directEntry(VPS, "https://vps.tail1234.ts.net"), [
        "http://127.0.0.1:3773",
        "https://vps.tail1234.ts.net",
        "http://192.168.1.4:3773",
      ]),
    ).toEqual(["https://vps.tail1234.ts.net", "http://192.168.1.4:3773"]);
  });

  it("has nothing to pass on for a route only this client can use", () => {
    const relay: ConnectionCatalogEntry = {
      target: new RelayConnectionTarget({ environmentId: VPS, label: "Env" }),
      profile: Option.none(),
      enabled: true,
    };
    expect(peerRoutesFor(relay)).toEqual([]);
    expect(peerRoutesFor(directEntry(MAC, "http://localhost:3773"))).toEqual([]);
  });
});

describe("linkPeerEnvironments", () => {
  function recorder(failOn?: EnvironmentId) {
    const updates: Array<{ environmentId: EnvironmentId; input: PeersUpdateInput }> = [];
    return {
      updates,
      deps: {
        mintCode: async (environmentId: EnvironmentId) => `code-for-${environmentId}`,
        update: async (environmentId: EnvironmentId, input: PeersUpdateInput) => {
          if (environmentId === failOn) throw new Error("rejected");
          updates.push({ environmentId, input });
        },
      },
    };
  }

  it("has each environment read the other with a code minted on the one being read", async () => {
    const { deps, updates } = recorder();
    const result = await linkPeerEnvironments(
      deps,
      { environmentId: MAC, routes: ["http://192.168.1.4:3773"] },
      { environmentId: VPS, routes: ["https://vps.example.com"] },
    );
    expect(result).toEqual({ aReadsB: { status: "linked" }, bReadsA: { status: "linked" } });
    expect(updates).toContainEqual({
      environmentId: MAC,
      input: { _tag: "link", code: `code-for-${VPS}`, routes: ["https://vps.example.com"] },
    });
    expect(updates).toContainEqual({
      environmentId: VPS,
      input: { _tag: "link", code: `code-for-${MAC}`, routes: ["http://192.168.1.4:3773"] },
    });
  });

  it("links the direction that has an address and names the one that does not", async () => {
    const { deps, updates } = recorder();
    const result = await linkPeerEnvironments(
      deps,
      { environmentId: MAC, routes: [] },
      { environmentId: VPS, routes: ["https://vps.example.com"] },
    );
    expect(result.aReadsB).toEqual({ status: "linked" });
    expect(result.bReadsA).toEqual({ status: "no-route" });
    expect(updates.map((update) => update.environmentId)).toEqual([MAC]);
  });

  it("reports a failed direction without hiding the other", async () => {
    const { deps } = recorder(VPS);
    const result = await linkPeerEnvironments(
      deps,
      { environmentId: MAC, routes: ["http://192.168.1.4:3773"] },
      { environmentId: VPS, routes: ["https://vps.example.com"] },
    );
    expect(result.aReadsB).toEqual({ status: "linked" });
    expect(result.bReadsA.status).toBe("failed");
  });
});

describe("unlinkPeerEnvironments", () => {
  it("removes both directions and reports a side that could not be reached", async () => {
    const calls: Array<string> = [];
    const failures = await unlinkPeerEnvironments(
      {
        update: async (environmentId, input) => {
          calls.push(`${environmentId}:${input._tag}`);
          if (environmentId === VPS) throw new Error("offline");
        },
      },
      MAC,
      VPS,
    );
    expect(calls.toSorted()).toEqual([`${MAC}:unlink`, `${VPS}:unlink`]);
    expect(failures.map((failure) => failure.reader)).toEqual([VPS]);
  });
});

describe("peerLinkAvailability", () => {
  const base = { connected: true, primaryAllowed: true, peerAllowed: true, linked: false };
  it("offers Link only when both sides are connected and manageable", () => {
    expect(peerLinkAvailability(base)).toEqual({ kind: "link" });
    expect(peerLinkAvailability({ ...base, connected: false })).toEqual({
      kind: "disabled",
      reason: "offline",
    });
    expect(peerLinkAvailability({ ...base, peerAllowed: false })).toEqual({
      kind: "disabled",
      reason: "permission",
    });
    expect(peerLinkAvailability({ ...base, primaryAllowed: false })).toEqual({
      kind: "disabled",
      reason: "permission",
    });
  });

  it("offers Unlink for an existing link even when the other side is offline", () => {
    expect(peerLinkAvailability({ ...base, linked: true, connected: false })).toEqual({
      kind: "unlink",
    });
    expect(
      peerLinkAvailability({ ...base, linked: true, primaryAllowed: false, connected: false }),
    ).toEqual({ kind: "unlink" });
    expect(
      peerLinkAvailability({ ...base, linked: true, primaryAllowed: false, peerAllowed: false }),
    ).toEqual({ kind: "disabled", reason: "permission" });
  });
});

describe("peerLinkSubtitle", () => {
  it("says nothing without a link and names the worse direction otherwise", () => {
    expect(peerLinkSubtitle(null, null)).toBeNull();
    expect(peerLinkSubtitle({ status: "ok" }, { status: "ok" })).toBe("Threads linked");
    expect(peerLinkSubtitle({ status: "ok" }, null)).toBe("Threads linked one way");
    // Not yet checked is not a problem.
    expect(peerLinkSubtitle({}, {})).toBe("Threads linked");
    expect(peerLinkSubtitle({ status: "ok" }, { status: "unauthorized" })).toBe(
      "Link was revoked on the other side",
    );
  });
});

describe("unreadableThreadRefs", () => {
  const other = EnvironmentId.make("environment-other");
  const refs = [
    { environmentId: MAC, threadId: "own" },
    { environmentId: VPS, threadId: "linked" },
    { environmentId: other, threadId: "stranger" },
  ];
  it("lets a composer attach its own environment's threads and a linked environment's, not others", () => {
    expect(unreadableThreadRefs(refs, MAC, [{ environmentId: VPS }])).toEqual([refs[2]]);
    expect(unreadableThreadRefs(refs, MAC, [])).toEqual([refs[1], refs[2]]);
  });
});
