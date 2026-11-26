import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Forge from "./ForgeReadService.ts";
import * as Weave from "./WeaveAgentConnections.ts";

const item = {
  id: "spec-id",
  kind: "spec",
  ref: "WV-143",
  bodyRevision: 3,
  acceptanceRowIds: ["row-1"],
};
const origin = "https://weave.example.test";
const response = (value: unknown) => Effect.succeed({ origin, connection: "test", value });
const refused = (reason: Weave.WeaveObserveError["reason"], code?: string) =>
  Effect.fail(new Weave.WeaveObserveError({ reason, code }));

const read = (
  observe: Weave.WeaveAgentConnections["Service"]["observe"],
  input: Parameters<Forge.ForgeReadService["Service"]["read"]>[0] = { ref: " WV-143 " },
) =>
  Forge.ForgeReadService.use((forge) => forge.read(input)).pipe(
    Effect.provide(
      Forge.layer.pipe(Layer.provide(Layer.mock(Weave.WeaveAgentConnections)({ observe }))),
    ),
  );

it.effect("reads Spec context alongside a complete multi-chunk body", () =>
  Effect.gen(function* () {
    const bodyStarted = yield* Deferred.make<void>();
    const contextStarted = yield* Deferred.make<void>();
    const context = {
      tickets: [{ id: "t" }],
      decisions: [{ id: "d" }],
      waits: [{ id: "w" }],
      publications: [{ id: "p" }],
      councils: [{ id: "c" }],
    };
    const doc = yield* read((tool, args) => {
      if (tool === "weave_forge_query" && args.action === "read") {
        expect(args).toEqual({ action: "read", ref: "WV-143" });
        return response(item);
      }
      if (tool === "weave_forge_query") {
        expect(args).toEqual({ action: "context", specId: item.id });
        return Deferred.succeed(contextStarted, undefined).pipe(
          Effect.andThen(Deferred.await(bodyStarted)),
          Effect.andThen(response({ ...context, brief: "not returned" })),
        );
      }
      expect(tool).toBe("weave_docs_body_query");
      expect(args.action).toBe("get_body");
      expect(args.recordId).toBe(item.id);
      if (args.cursor === "second")
        return response({ content: "two", revision: 3, nextCursor: null });
      expect(args).not.toHaveProperty("cursor");
      return Deferred.succeed(bodyStarted, undefined).pipe(
        Effect.andThen(Deferred.await(contextStarted)),
        Effect.andThen(response({ content: "one ", revision: 3, nextCursor: "second" })),
      );
    });
    expect(doc).toEqual({
      origin,
      item,
      body: "one two",
      bodyRevision: 3,
      currentBodyRevision: 3,
      ...context,
    });
  }),
);

it.effect.each([2, 3])("returns the pinned revision %i even if the live body moves", (revision) =>
  Effect.gen(function* () {
    const tools: Array<string> = [];
    const doc = yield* read(
      (tool, args) => {
        tools.push(tool === "weave_docs_body_query" ? `${tool}:${String(args.action)}` : tool);
        if (tool === "weave_forge_query") return response(item);
        if (args.action === "get_body") return response({ content: "new", revision: 4 });
        expect(args).toEqual({ action: "get_revision", recordId: item.id, revision });
        return response({ content: "pinned", revision });
      },
      { ref: item.ref, bodyRevision: revision, includeContext: false },
    );
    expect(tools).toEqual([
      "weave_forge_query",
      ...(revision === 3 ? ["weave_docs_body_query:get_body"] : []),
      "weave_docs_body_query:get_revision",
    ]);
    expect(doc).toMatchObject({ body: "pinned", bodyRevision: revision, currentBodyRevision: 3 });
  }),
);

it.effect.each([true, false])(
  "restarts a changed live body once (second attempt succeeds: %s)",
  (succeeds) =>
    Effect.gen(function* () {
      const cursors: Array<unknown> = [];
      const outcome = yield* read((tool, args) => {
        if (tool === "weave_forge_query") return response({ ...item, kind: "ticket" });
        cursors.push(args.cursor);
        if (args.cursor === "old") return refused("failed", "chunk_version_changed");
        if (cursors.length === 1 || !succeeds)
          return response({ content: "stale", nextCursor: "old" });
        return response({ content: "fresh", revision: 4 });
      }).pipe(Effect.result);
      expect(cursors).toEqual(
        succeeds ? [undefined, "old", undefined] : [undefined, "old", undefined, "old"],
      );
      if (succeeds) expect(outcome).toMatchObject({ success: { body: "fresh", bodyRevision: 4 } });
      else
        expect(outcome).toMatchObject({
          failure: { reason: "failed", code: "chunk_version_changed" },
        });
    }),
);

it.effect.each(["ticket", "decision", "arc", "spec"])("can read a %s without context", (kind) =>
  Effect.gen(function* () {
    const doc = yield* read(
      (tool, args) => {
        if (tool === "weave_forge_query") {
          expect(args.action).toBe("read");
          return response({ id: item.id, kind });
        }
        return response({ content: "" });
      },
      kind === "spec" ? { ref: item.ref, includeContext: false } : { ref: item.ref },
    );
    expect(doc).toEqual({
      origin,
      item: { id: item.id, kind },
      body: "",
      bodyRevision: 0,
      currentBodyRevision: null,
    });
  }),
);

it.effect.each(["not_connected", "refused", "unavailable", "failed"] as const)(
  "reports %s Forge reads",
  (reason) =>
    Effect.gen(function* () {
      const code = reason === "failed" ? "build_item_unknown" : undefined;
      const error = yield* read(() => refused(reason, code)).pipe(Effect.flip);
      expect(error).toMatchObject({ reason, code });
      expect(error.message).toContain(
        code ?? (reason === "unavailable" ? "Try again" : "Settings → Weave"),
      );
    }),
);

it.effect.each(["failed", "not_connected", "refused", "unavailable"] as const)(
  "distinguishes an optional context refusal from a %s connection failure",
  (reason) =>
    Effect.gen(function* () {
      const outcome = yield* read((tool, args) => {
        if (args.action === "read") return response(item);
        return tool === "weave_forge_query"
          ? refused(reason, "action_unknown")
          : response({ content: "body", revision: 3 });
      }).pipe(Effect.result);
      if (reason === "failed")
        expect(outcome).toMatchObject({
          success: { body: "body", contextWarning: expect.stringContaining("action_unknown") },
        });
      else expect(outcome).toMatchObject({ failure: { reason } });
    }),
);

it.effect.each(["chunks", "size", "cursor", "shape"] as const)(
  "rejects an invalid body (%s) instead of returning partial content",
  (guard) =>
    Effect.gen(function* () {
      let count = 0;
      const error = yield* read((tool) => {
        if (tool === "weave_forge_query") return response({ ...item, kind: "ticket" });
        count++;
        if (guard === "shape") return response({ content: null });
        if (guard === "size") return response({ content: "é".repeat(256 * 1024 + 1) });
        return response({ content: ".", nextCursor: guard === "cursor" ? "same" : String(count) });
      }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_response");
      expect(count).toBe(guard === "chunks" ? 64 : guard === "cursor" ? 2 : 1);
    }),
);

it.effect(
  "reads a body from a Weave that still has a tool per Doc action, asking the grouped tool once",
  () =>
    Effect.gen(function* () {
      const tools: Array<string> = [];
      const doc = yield* read(
        (tool, args) => {
          tools.push(tool);
          if (tool === "weave_forge_query") return response({ ...item, kind: "ticket" });
          if (tool === "weave_docs_body_query") return refused("failed", "mcp_tool_unavailable");
          expect(tool).toBe("weave_docs_get_body");
          expect(args).not.toHaveProperty("action");
          return args.cursor === "second"
            ? response({ content: "two", revision: 3 })
            : response({ content: "one ", revision: 3, nextCursor: "second" });
        },
        { ref: item.ref },
      );
      expect(tools).toEqual([
        "weave_forge_query",
        "weave_docs_body_query",
        "weave_docs_get_body",
        "weave_docs_get_body",
      ]);
      expect(doc).toMatchObject({ body: "one two", bodyRevision: 3 });
    }),
);
