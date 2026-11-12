import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as BwsClient from "./BwsClient.ts";

const fake = vi.hoisted(() => ({
  list: vi.fn(),
  getByIds: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  project: vi.fn(),
  login: vi.fn(),
}));
vi.mock("@bitwarden/sdk-napi", () => ({
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
}));

it.effect("filters scoped metadata and redacts SDK failures", () =>
  Effect.gen(function* () {
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
