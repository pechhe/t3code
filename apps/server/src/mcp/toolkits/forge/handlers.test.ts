import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Forge from "../../../weave/ForgeReadService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ForgeToolkit } from "./tools.ts";

const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(),
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("test"),
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("test"),
  },
  client: undefined,
  requestNamespace: "test",
  endpointKey: "reader",
};

const run = (
  read: Forge.ForgeReadService["Service"]["read"],
  input: Schema.Json,
  invocation = scope,
) =>
  Effect.gen(function* () {
    const toolkit = yield* ForgeToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer)),
    );
    const results = yield* toolkit
      .handle("t3_forge_read", input)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  }).pipe(
    Effect.provideService(Invocation.McpInvocationContext, invocation),
    Effect.provideService(Forge.ForgeReadService, { read }),
  );

const origin = "https://weave.example.test";
it.effect("forwards a read-only caller's ref and options and returns the Doc", () =>
  Effect.gen(function* () {
    const input = { ref: "WV-143", bodyRevision: 2, includeContext: false };
    const doc = {
      origin,
      item: { kind: "spec" },
      body: "# Spec",
      bodyRevision: 2,
      currentBodyRevision: 3,
    };
    const result = yield* run(
      (params) => {
        expect(params).toEqual(input);
        return Effect.succeed(doc);
      },
      { ...input, ref: " WV-143 " },
    );
    expect(result).toEqual(doc);
  }),
);

it.effect("refuses an outside client that knows the tool name", () =>
  Effect.gen(function* () {
    const result = yield* run(
      () => Effect.die("An outside client must never call Weave."),
      { ref: "WV-143" },
      {
        ...scope,
        thread: undefined,
        client: { sessionId: "oauth", label: "Outside app", access: "read-only" },
      },
    );
    expect(result).toMatchObject({ code: "thread_credential_required" });
  }),
);

it.effect("turns an observer refusal into actionable MCP guidance", () =>
  Effect.gen(function* () {
    const result = yield* run(
      () =>
        Effect.fail(new Forge.ForgeReadError({ reason: "failed", code: "doc_revision_unknown" })),
      { ref: "WV-143", bodyRevision: 2 },
    );
    expect(result).toMatchObject({
      code: "orchestration_error",
      message: expect.stringContaining("doc_revision_unknown"),
    });
  }),
);
