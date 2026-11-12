import { assert, it } from "@effect/vitest";
import { SecretManagementError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BwsClient from "./BwsClient.ts";
import * as SavedSecrets from "./SavedSecrets.ts";

it.effect("scopes, protects and preserves opaque values and durable write receipts", () =>
  Effect.gen(function* () {
    const records = new Map<string, BwsClient.BwsSecret>([
      [
        "a",
        { id: "a", key: "ALPHA", projectId: "p", value: "  value\nsecond\n", note: "keep note" },
      ],
      [
        "b",
        {
          id: "b",
          key: "BROWSER_LOGIN_SITE",
          projectId: "p",
          value: " login\n",
          note: "https://example.com",
        },
      ],
      ["x", { id: "x", key: "OTHER", projectId: "other", value: "hidden", note: "" }],
    ]);
    const receipts = new Map<string, Uint8Array>();
    let writes = 0;
    let failWrite = false;
    const client = BwsClient.BwsClient.of({
      projectId: Effect.succeed("p"),
      list: () =>
        Effect.sync(() =>
          [...records.values()]
            .filter((s) => s.projectId === "p")
            .map((s) => ({ id: s.id, key: s.key, projectId: "p" })),
        ),
      get: (id) => Effect.sync(() => records.get(id)!),
      create: (key, value) =>
        Effect.gen(function* () {
          writes++;
          if (failWrite) return yield* new SecretManagementError({ reason: "unavailable" });
          const entry = { id: `new${writes}`, key, value, projectId: "p", note: "" };
          records.set(entry.id, entry);
          return entry;
        }),
      update: (old, key, value) =>
        Effect.sync(() => {
          writes++;
          const entry = { ...old, key, value };
          records.set(old.id, entry);
          return entry;
        }),
      remove: (id) =>
        Effect.sync(() => {
          records.delete(id);
        }),
    });
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(receipts.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          receipts.set(name, value);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
      remove: () => Effect.die("unused"),
    });
    yield* Effect.gen(function* () {
      const service = yield* SavedSecrets.SavedSecrets;
      assert.equal(
        (yield* Effect.flip(
          service.save({
            projectId: "old-project",
            key: "NEW",
            secret: "value",
            clientRequestId: "changed-project",
          }),
        )).reason,
        "destination_changed",
      );
      assert.equal(writes, 0);
      const first = yield* service.list({ limit: 1 });
      assert.deepStrictEqual(first.entries, [
        { id: "a", key: "ALPHA", projectId: "p", browserLogin: false },
      ]);
      assert.strictEqual(first.nextCursor, "a");
      assert.deepStrictEqual(
        (yield* service.list({ cursor: first.nextCursor!, limit: 1 })).entries.map((x) => x.id),
        ["b"],
      );
      assert.strictEqual(yield* service.read("a"), "  value\nsecond\n");
      assert.strictEqual((yield* Effect.flip(service.read("b"))).reason, "protected");
      assert.strictEqual(yield* service.reveal("b"), " login\n");
      assert.strictEqual((yield* Effect.flip(service.reveal("x"))).reason, "not_found");
      assert.strictEqual(
        (yield* Effect.flip(
          service.save({ projectId: "p", key: "ALPHA", secret: "z", clientRequestId: "dup" }),
        )).reason,
        "exists",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          service.save({ projectId: "p", id: "b", key: "NORMAL", clientRequestId: "rename" }),
        )).reason,
        "protected",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          service.save({
            projectId: "p",
            id: "a",
            key: "BROWSER_LOGIN_NEW",
            clientRequestId: "rename2",
          }),
        )).reason,
        "protected",
      );
      const input = {
        projectId: "p",
        id: "a",
        key: "CHANGED",
        secret: "\nnew  ",
        clientRequestId: "request",
      };
      const [result, simultaneous] = yield* Effect.all([service.save(input), service.save(input)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(simultaneous, result);
      assert.deepStrictEqual(yield* service.save(input), result);
      assert.strictEqual(writes, 1);
      assert.strictEqual(records.get("a")?.note, "keep note");
      assert.strictEqual(yield* service.read("a"), "\nnew  ");
      assert.strictEqual(
        (yield* Effect.flip(service.save({ ...input, secret: "different" }))).reason,
        "invalid",
      );
      failWrite = true;
      const uncertain = {
        projectId: "p",
        key: "NEW",
        secret: "private\n",
        clientRequestId: "uncertain",
      };
      assert.strictEqual((yield* Effect.flip(service.save(uncertain))).reason, "uncertain");
      failWrite = false;
      assert.strictEqual((yield* Effect.flip(service.save(uncertain))).reason, "uncertain");
      assert.strictEqual(writes, 2);
      assert.isFalse(
        [...receipts.values()].some((v) => new TextDecoder().decode(v).includes("private")),
      );
      yield* service.remove("a");
      assert.strictEqual((yield* Effect.flip(service.read("a"))).reason, "not_found");
    }).pipe(
      Effect.provide(SavedSecrets.layer),
      Effect.provideService(BwsClient.BwsClient, client),
      Effect.provideService(ServerSecretStore.ServerSecretStore, store),
    );
  }),
);
