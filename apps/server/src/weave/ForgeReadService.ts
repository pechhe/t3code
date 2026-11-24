import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

export class ForgeReadError extends Schema.TaggedError<
  ForgeReadError,
  { readonly brand: unique symbol }
>()("ForgeReadError", {
  reason: Schema.Literals([
    "not_connected",
    "refused",
    "unavailable",
    "failed",
    "invalid_response",
  ]),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_connected":
        return "T3 is not connected to Weave. Connect in Settings → Weave.";
      case "refused":
        return "T3's Weave connection was revoked or expired. Reconnect in Settings → Weave.";
      case "unavailable":
        return "T3 could not reach Weave right now. Try again.";
      case "failed":
        return this.code
          ? `Weave refused the Forge read (${this.code}).`
          : "Weave refused the Forge read.";
      case "invalid_response":
        return "Weave returned an unexpected Forge response or the Doc exceeded the read limit.";
    }
  }
}

const ItemRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeItem = Schema.decodeUnknownOption(
  Schema.StructWithRest(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      bodyRevision: Schema.optional(Schema.NullOr(Schema.Int)),
    }),
    [ItemRecord],
  ),
);

const decodeChunk = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.String,
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
    revision: Schema.optional(Schema.Int),
  }),
);

const ContextFields = Schema.Struct({
  tickets: Schema.optional(Schema.Array(Schema.Unknown)),
  decisions: Schema.optional(Schema.Array(Schema.Unknown)),
  waits: Schema.optional(Schema.Array(Schema.Unknown)),
  publications: Schema.optional(Schema.Array(Schema.Unknown)),
  councils: Schema.optional(Schema.Array(Schema.Unknown)),
});

const decodeContext = Schema.decodeUnknownOption(ItemRecord);
const contextKeys = ["tickets", "decisions", "waits", "publications", "councils"] as const;

export const ForgeReadResult = Schema.Struct({
  origin: Schema.String,
  item: ItemRecord,
  body: Schema.String,
  bodyRevision: Schema.Int,
  currentBodyRevision: Schema.NullOr(Schema.Int),
  ...ContextFields.fields,
  contextWarning: Schema.optional(Schema.String),
});

interface ForgeReadInput {
  readonly ref: string;
  readonly bodyRevision?: number | undefined;
  readonly includeContext?: boolean | undefined;
}

export class ForgeReadService extends Context.Service<
  ForgeReadService,
  {
    readonly read: (
      input: ForgeReadInput,
    ) => Effect.Effect<typeof ForgeReadResult.Type, ForgeReadError>;
  }
>()("t3/weave/ForgeReadService") {}

const MAX_CHUNKS = 64;
const MAX_BODY_BYTES = 512 * 1024;

const make = Effect.gen(function* () {
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  const observe = (tool: string, args: Record<string, unknown>) =>
    weave
      .observe(tool, args)
      .pipe(
        Effect.mapError(
          (cause) => new ForgeReadError({ reason: cause.reason, code: cause.code, cause }),
        ),
      );

  const read = Effect.fn("ForgeReadService.read")(function* (input: ForgeReadInput) {
    const result = yield* observe("weave_forge_query", { action: "read", ref: input.ref.trim() });
    const decoded = decodeItem(result.value);
    if (Option.isNone(decoded)) return yield* new ForgeReadError({ reason: "invalid_response" });
    const item = decoded.value;
    const currentBodyRevision = item.bodyRevision ?? null;
    const requestedRevision = input.bodyRevision;
    const fallbackRevision = requestedRevision ?? currentBodyRevision ?? 0;

    const readValue = (tool: string, args: Record<string, unknown>) =>
      observe(tool, args).pipe(
        // A reconnect must not mix results from different Weave connections.
        Effect.flatMap((part) =>
          part.connection === result.connection
            ? Effect.succeed(part.value)
            : Effect.fail(new ForgeReadError({ reason: "unavailable" })),
        ),
      );

    const readDocChunks = Effect.fn("ForgeReadService.readDocChunks")(function* (
      tool: "weave_docs_get_body" | "weave_docs_get_revision",
      baseArgs: Record<string, unknown>,
    ) {
      const chunks: Array<string> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      let revision: number | undefined;
      for (let count = 0; count < MAX_CHUNKS; count++) {
        const value = yield* readValue(
          tool,
          cursor === undefined ? baseArgs : { ...baseArgs, cursor },
        );
        const chunk = decodeChunk(value);
        if (Option.isNone(chunk)) return yield* new ForgeReadError({ reason: "invalid_response" });
        const { content, nextCursor, revision: chunkRevision } = chunk.value;
        if (revision !== undefined && chunkRevision !== undefined && revision !== chunkRevision)
          return yield* new ForgeReadError({ reason: "invalid_response" });
        revision ??= chunkRevision;
        bytes += Buffer.byteLength(content, "utf8");
        if (bytes > MAX_BODY_BYTES)
          return yield* new ForgeReadError({ reason: "invalid_response" });
        chunks.push(content);
        if (!nextCursor)
          return { body: chunks.join(""), bodyRevision: revision ?? fallbackRevision };
        if (seen.has(nextCursor)) return yield* new ForgeReadError({ reason: "invalid_response" });
        seen.add(nextCursor);
        cursor = nextCursor;
      }
      return yield* new ForgeReadError({ reason: "invalid_response" });
    });

    const body = Effect.gen(function* () {
      const readRevision = (revision: number) =>
        readDocChunks("weave_docs_get_revision", { recordId: item.id, revision }).pipe(
          Effect.filterOrFail(
            (doc) => doc.bodyRevision === revision,
            () => new ForgeReadError({ reason: "invalid_response" }),
          ),
        );
      if (requestedRevision !== undefined && requestedRevision !== currentBodyRevision)
        return yield* readRevision(requestedRevision);
      const current = readDocChunks("weave_docs_get_body", { recordId: item.id });
      const doc = yield* current.pipe(
        Effect.catchIf(
          (error) => error.reason === "failed" && error.code === "chunk_version_changed",
          () => current,
        ),
      );
      if (requestedRevision !== undefined && doc.bodyRevision !== requestedRevision)
        return yield* readRevision(requestedRevision);
      return doc;
    });

    const context =
      item.kind === "spec" && input.includeContext !== false
        ? readValue("weave_forge_query", { action: "context", specId: item.id }).pipe(
            Effect.flatMap((value) => {
              const record = decodeContext(value);
              if (Option.isNone(record))
                return Effect.fail(new ForgeReadError({ reason: "invalid_response" }));
              const fields: Partial<Record<(typeof contextKeys)[number], ReadonlyArray<unknown>>> =
                {};
              for (const key of contextKeys) {
                const field = record.value[key];
                if (Array.isArray(field)) fields[key] = field;
              }
              return Effect.succeed(fields);
            }),
            Effect.catchIf(
              (error) => error.reason === "failed" || error.reason === "invalid_response",
              (error) =>
                Effect.succeed({ contextWarning: `Spec context unavailable. ${error.message}` }),
            ),
          )
        : Effect.succeed({});
    const [doc, fields] = yield* Effect.all([body, context], { concurrency: "unbounded" });
    return { origin: result.origin, item, ...doc, currentBodyRevision, ...fields };
  });
  return ForgeReadService.of({ read });
});

export const layer = Layer.effect(ForgeReadService, make);
