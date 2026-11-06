import { PREVIEW_TASK_LIMITS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { McpSchema } from "effect/ai";

export const TASK_IMAGE_TOOLS: ReadonlySet<string> = new Set(["t3_browser_task", "preview_task"]);
/** Adapters that accept image tool results; providers replay images later, and some reject them. */
const IMAGE_RESULT_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * A bounded task's result is JSON; when the caller asks, its last screenshots ride along as
 * images, read back from their saved paths. A replay never resends them.
 */
export const attachTaskImages = Effect.fn("attachTaskImages")(function* (
  result: McpSchema.CallToolResult | McpSchema.InputRequired,
  input: { readonly includeImages: unknown; readonly driver: string | undefined },
) {
  if (!("content" in result) || input.includeImages !== true || result.isError === true)
    return result;
  if (input.driver === undefined || !IMAGE_RESULT_DRIVERS.has(input.driver)) return result;
  const task = result.structuredContent as
    | {
        readonly replayed?: boolean;
        readonly screenshots?: ReadonlyArray<{ readonly path: string; readonly mimeType: string }>;
      }
    | undefined;
  const shots = task?.screenshots ?? [];
  if (task?.replayed === true || shots.length === 0) return result;
  const fileSystem = yield* FileSystem.FileSystem;
  const images = yield* Effect.forEach(shots.slice(-PREVIEW_TASK_LIMITS.inlineImages), (shot) =>
    fileSystem.readFile(shot.path).pipe(
      Effect.map((data) => [{ type: "image" as const, data, mimeType: shot.mimeType }]),
      Effect.orElseSucceed(() => []),
    ),
  );
  return new McpSchema.CallToolResult({
    ...result,
    content: [...result.content, ...images.flat()],
  });
});
