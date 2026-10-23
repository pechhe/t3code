/**
 * `/v1/models` ids for T3's provider instances and models.
 *
 * FluidVoice asks for a model id and echoes it back on every completion, so the
 * id has to carry both halves of a {@link ModelSelection}. Provider instance ids
 * never contain a slash; model ids often do (`opencode-go/deepseek-v4.1-flash`),
 * so the split is on the first one.
 */
export type DecodedModelId = {
  readonly instanceId: string;
  readonly model: string;
};

export function encodeModelId(instanceId: string, model: string): string {
  return `${instanceId}/${model}`;
}

export function decodeModelId(id: string): DecodedModelId | null {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return null;
  return { instanceId: id.slice(0, separator), model: id.slice(separator + 1) };
}
