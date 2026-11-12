import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as BwsClient from "./BwsClient.ts";

const fake = vi.hoisted(() => ({
  list: vi.fn(),
  getByIds: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  project: vi.fn(),
  login: vi.fn(),
  load: vi.fn(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => {
    fake.load();
    return {
      BitwardenClient: class {
        auth() {
          return { loginAccessToken: fake.login };
        }
        projects() {
          return { get: fake.project };
        }
        secrets() {
          return { list: fake.list, getByIds: fake.getByIds, get: fake.get, update: fake.update };
        }
      },
    };
  },
}));

it.effect("filters scoped metadata and redacts SDK failures", () =>
  Effect.gen(function* () {
    fake.load.mockReset();
    fake.login.mockResolvedValue(undefined);
    fake.project.mockResolvedValue({ id: "p", organizationId: "org" });
    fake.list.mockResolvedValue({ data: [{ id: "a" }, { id: "b" }] });
    fake.getByIds.mockResolvedValue({
      data: [
        { id: "a", key: "A", projectId: "p", value: "private", note: "private note" },
        { id: "b", key: "B", projectId: "other", value: "other", note: "" },
      ],
    });
    fake.update.mockResolvedValue({
      id: "a",
      key: "A",
      projectId: "p",
      value: "new",
      note: "note",
    });
    const environment = { BWS_ACCESS_TOKEN: "fake-token", T3CODE_BWS_PROJECT_ID: "p" };
    yield* Effect.gen(function* () {
      const client = yield* BwsClient.BwsClient;
      assert.deepEqual(yield* client.list(), [{ id: "a", key: "A", projectId: "p" }]);
      environment.T3CODE_BWS_PROJECT_ID = "changed-after-inventory";
      yield* client.update(
        { id: "a", key: "A", value: "old", note: "note", projectId: "p" },
        "A",
        "new",
      );
      assert.equal(fake.project.mock.calls.at(-1)?.[0], "p");
      assert.deepEqual(fake.update.mock.calls.at(-1), ["org", "a", "A", "new", "note", ["p"]]);
      fake.get.mockRejectedValue(new Error("secret token private"));
      const failure = yield* Effect.flip(client.get("a"));
      assert.equal(failure.reason, "unavailable");
      assert.notInclude(JSON.stringify(failure), "secret token private");
    }).pipe(
      Effect.provide(BwsClient.layer),
      Effect.provideService(HostProcess.Environment, environment),
    );
  }),
);

it.effect("starts without loading an unavailable native SDK and redacts its load failure", () =>
  Effect.gen(function* () {
    fake.load.mockImplementation(() => {
      throw new Error("native loader private details");
    });
    yield* Effect.gen(function* () {
      const client = yield* BwsClient.BwsClient;
      const failure = yield* Effect.flip(client.get("a"));
      assert.equal(failure.reason, "unavailable");
      assert.notInclude(JSON.stringify(failure), "private details");
    }).pipe(
      Effect.provide(BwsClient.layer),
      Effect.provideService(HostProcess.Environment, { T3CODE_BWS_PROJECT_ID: "p" }),
    );
  }),
);

it.effect(
  "shares pending inventory reads and retries only the throttled batch without caching later results",
  () =>
    Effect.gen(function* () {
      fake.load.mockReset();
      fake.login.mockResolvedValue(undefined);
      fake.project.mockResolvedValue({ id: "p", organizationId: "org" });
      const identifiers = Array.from({ length: 425 }, (_, index) => ({ id: String(index) }));
      fake.list.mockReset().mockResolvedValue({ data: identifiers });
      fake.getByIds.mockReset().mockImplementation(async (ids: string[]) => {
        if (fake.getByIds.mock.calls.length === 2) throw new Error("429 Too Many Requests private");
        return {
          data: ids.map((id) => ({
            id,
            key: `KEY_${id}`,
            projectId: "p",
            value: "private",
            note: "private",
          })),
        };
      });
      yield* Effect.gen(function* () {
        const client = yield* BwsClient.BwsClient;
        const fiber = yield* Effect.all([client.list(), client.list()], { concurrency: 2 }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 minute");
        const [entries, concurrentEntries] = yield* Fiber.join(fiber);
        assert.deepEqual(
          entries,
          identifiers.map(({ id }) => ({ id, key: `KEY_${id}`, projectId: "p" })),
        );
        assert.deepEqual(concurrentEntries, entries);
        assert.equal(fake.list.mock.calls.length, 1);
        assert.equal(fake.getByIds.mock.calls.length, 6);
        assert.notInclude(JSON.stringify(entries), "private");
        fake.list.mockResolvedValue({ data: [] });
        assert.deepEqual(yield* client.list(), []);
        assert.equal(fake.list.mock.calls.length, 2);
      }).pipe(
        Effect.provide(BwsClient.layer),
        Effect.provideService(HostProcess.Environment, {
          BWS_ACCESS_TOKEN: "fake-token",
          T3CODE_BWS_PROJECT_ID: "p",
        }),
      );
    }),
);

it.effect("bounds throttled reads and never retries other failures or mutations", () =>
  Effect.gen(function* () {
    fake.load.mockReset();
    fake.login.mockResolvedValue(undefined);
    fake.project.mockResolvedValue({ id: "p", organizationId: "org" });
    fake.list.mockResolvedValue({ data: [{ id: "a" }] });
    for (const scenario of ["throttled-read", "denied-read", "throttled-write"] as const) {
      fake.getByIds
        .mockReset()
        .mockRejectedValue(new Error(scenario === "denied-read" ? "401 private" : "429 private"));
      fake.update.mockReset().mockRejectedValue(new Error("429 private"));
      yield* Effect.gen(function* () {
        const client = yield* BwsClient.BwsClient;
        const operation =
          scenario === "throttled-write"
            ? client
                .update(
                  { id: "a", key: "A", projectId: "p", value: "old", note: "note" },
                  "A",
                  "new",
                )
                .pipe(Effect.asVoid)
            : client.list().pipe(Effect.asVoid);
        const fiber = yield* Effect.flip(operation).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        const failure = yield* Fiber.join(fiber);
        assert.equal(failure.reason, "unavailable");
        assert.notInclude(JSON.stringify(failure), "private");
        assert.equal(
          fake.getByIds.mock.calls.length,
          scenario === "throttled-read" ? 3 : scenario === "denied-read" ? 1 : 0,
        );
        assert.equal(fake.update.mock.calls.length, scenario === "throttled-write" ? 1 : 0);
      }).pipe(
        Effect.provide(BwsClient.layer),
        Effect.provideService(HostProcess.Environment, {
          BWS_ACCESS_TOKEN: "fake-token",
          T3CODE_BWS_PROJECT_ID: "p",
        }),
      );
    }
  }),
);

it("selects the host localdev project and requires an explicit choice for missing or duplicate names", () => {
  assert.equal(
    BwsClient.selectDefaultProject([
      { id: "fork-project", name: "localdev" },
      { id: "other", name: "production" },
    ]),
    "fork-project",
  );
  assert.throws(() => BwsClient.selectDefaultProject([]));
  assert.throws(() =>
    BwsClient.selectDefaultProject([
      { id: "a", name: "localdev" },
      { id: "b", name: "localdev" },
    ]),
  );
});
