import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { McpSchema } from "effect/ai";

import { attachTaskImages } from "./taskImages.ts";

const task = (structuredContent: object) =>
  new McpSchema.CallToolResult({
    isError: false,
    structuredContent,
    content: [{ type: "text", text: "{}" }],
  });

const images = (result: McpSchema.CallToolResult | McpSchema.InputRequired) =>
  "content" in result
    ? result.content.flatMap((item) =>
        item.type === "image" ? [Array.from(item.data as Uint8Array)[0]] : [],
      )
    : [];

const savedShots = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped();
  for (const index of [1, 2, 3, 4])
    yield* fileSystem.writeFile(`${dir}/shot-${index}.png`, new Uint8Array([index]));
  return [1, 2, 3, 4].map((index) => ({
    path: `${dir}/shot-${index}.png`,
    mimeType: "image/png",
  }));
});

it.effect("attaches the last three screenshots for Claude and Codex callers who ask", () =>
  Effect.gen(function* () {
    const result = task({ screenshots: yield* savedShots });
    const attach = (driver: string | undefined, includeImages: unknown = true) =>
      attachTaskImages(result, { includeImages, driver }).pipe(Effect.map(images));
    expect(yield* attach("claudeAgent")).toEqual([2, 3, 4]);
    expect(yield* attach("codex")).toEqual([2, 3, 4]);
    // Another provider, or a caller that did not ask, gets the paths alone.
    expect(yield* attach("opencode")).toEqual([]);
    expect(yield* attach(undefined)).toEqual([]);
    expect(yield* attach("codex", false)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never resends images on a replay or with a failure", () =>
  Effect.gen(function* () {
    const screenshots = yield* savedShots;
    const replay = task({ replayed: true, screenshots });
    expect(
      images(yield* attachTaskImages(replay, { includeImages: true, driver: "codex" })),
    ).toEqual([]);
    const failed = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: { screenshots },
      content: [],
    });
    expect(
      images(yield* attachTaskImages(failed, { includeImages: true, driver: "codex" })),
    ).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
