import {
  AuthOrchestrationReadScope,
  authScopeRequiredResponse,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChampionSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  environments: null as unknown as Atom.Writable<ReadonlyArray<unknown>>,
  live: new Map<string, Atom.Writable<unknown>>(),
}));

vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  fixtures.environments = Atom.make<ReadonlyArray<unknown>>([]).pipe(Atom.keepAlive);
  return { environmentSummaries: { environmentsAtom: fixtures.environments } };
});

vi.mock("./server", () => ({
  serverEnvironment: {
    championsLive: ({ environmentId }: { readonly environmentId: string }) =>
      fixtures.live.get(environmentId),
  },
}));

import { allChampionsAtom } from "./champions";

const A = EnvironmentId.make("machine-a");
const B = EnvironmentId.make("machine-b");

const champion = (id: string): ChampionSummary => ({
  id,
  projectId: ProjectId.make("project"),
  name: id,
  purpose: "Stay fast",
  schedule: { type: "fixed_time", timeOfDay: "06:00" },
  setupModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  routineModelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "m" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 3, instructions: "" },
  lifecycle: "active",
  ownerThreadId: ThreadId.make("owner"),
  setupThreadId: null,
  nextCheckAt: null,
  lastCheckAt: null,
  outstandingCheckId: null,
  outstandingSetupId: null,
  attention: [],
  openFindingCount: 0,
  pendingProposal: false,
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const listed = (id: string) => AsyncResult.success({ champions: [champion(id)] });

function setup() {
  const live = {
    a: Atom.make<unknown>(listed("a")).pipe(Atom.keepAlive),
    b: Atom.make<unknown>(listed("b")).pipe(Atom.keepAlive),
  };
  fixtures.live.set(A, live.a);
  fixtures.live.set(B, live.b);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(allChampionsAtom);
  const machines = (a: { connectionState: string; isEnabled?: boolean } | null) =>
    registry.set(fixtures.environments, [
      ...(a === null ? [] : [{ environmentId: A, isEnabled: true, ...a }]),
      { environmentId: B, isEnabled: true, connectionState: "connected" },
    ]);
  machines({ connectionState: "connected" });
  const read = (id: string) =>
    registry.get(allChampionsAtom).find((source) => source.environmentId === id);
  return { registry, live, machines, read, [Symbol.dispose]: unmount };
}

describe("allChampionsAtom", () => {
  it.each(["reconnecting", "connecting", "offline"])(
    "keeps the last list through %s and labels it, leaving the other machine live",
    (connectionState) => {
      using harness = setup();
      harness.machines({ connectionState });
      expect(harness.read(A)).toMatchObject({
        connection: connectionState,
        error: null,
        champions: [{ id: "a" }],
      });
      expect(harness.read(B)).toMatchObject({ connection: "connected", champions: [{ id: "b" }] });

      harness.machines({ connectionState: "connected" });
      harness.registry.set(harness.live.a, listed("a-updated"));
      expect(harness.read(A)).toMatchObject({
        connection: "connected",
        champions: [{ id: "a-updated" }],
      });
    },
  );

  it("doesn't report a stream failure from a machine that is already known to be away", () => {
    using harness = setup();
    harness.registry.set(
      harness.live.a,
      AsyncResult.failureWithPrevious(Cause.fail(new Error("socket closed")), {
        previous: Option.some(listed("a")),
      }),
    );
    harness.machines({ connectionState: "reconnecting" });
    expect(harness.read(A)).toMatchObject({ error: null, champions: [{ id: "a" }] });
  });

  it.each([
    ["explicit unregister", null],
    ["disabling the machine", { connectionState: "reconnecting", isEnabled: false }],
    ["a deliberate disconnect", { connectionState: "available" }],
    ["a blocked connection", { connectionState: "error" }],
  ])("forgets the list after %s", (_case, machine) => {
    using harness = setup();
    harness.machines(machine);
    expect(harness.read(A)).toBeUndefined();
    expect(harness.read(B)?.champions).toHaveLength(1);
  });

  it("drops the last list when the server revokes access on a live connection", () => {
    using harness = setup();
    harness.registry.set(
      harness.live.a,
      AsyncResult.failureWithPrevious(
        Cause.fail(
          new EnvironmentAuthorizationError({
            ...authScopeRequiredResponse(AuthOrchestrationReadScope),
            message: "This connection requires orchestration:read.",
          }),
        ),
        { previous: Option.some(listed("a")) },
      ),
    );
    expect(harness.read(A)).toMatchObject({ champions: null, connection: "connected" });
    expect(harness.read(A)?.error).not.toBeNull();
  });
});
