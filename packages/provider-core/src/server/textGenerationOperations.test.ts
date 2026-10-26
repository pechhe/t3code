import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeJsonReply } from "./textGenerationOperations.ts";

const outputSchema = Schema.Struct({ summary: Schema.String });

it.effect("takes a reply that is not JSON whole as the plain-text field", () =>
  Effect.gen(function* () {
    const reply = '## Goal\nShip "it"\n- step one';
    const decoded = yield* decodeJsonReply(
      { operation: "generateCompactionSummary", outputSchema, plainTextField: "summary" },
      "Pi",
      reply,
    );
    assert.strictEqual(decoded.summary, reply);
  }),
);

it.effect("still decodes a JSON reply when a plain-text field is set", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeJsonReply(
      { operation: "generateCompactionSummary", outputSchema, plainTextField: "summary" },
      "Pi",
      '{"summary":"done"}',
    );
    assert.strictEqual(decoded.summary, "done");
  }),
);

it.effect("rejects a non-JSON reply without a plain-text field", () =>
  Effect.gen(function* () {
    const error = yield* decodeJsonReply(
      { operation: "generateThreadTitle", outputSchema },
      "Pi",
      "not json",
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "TextGenerationError");
  }),
);
