/**
 * Fork-owned: an MCP client that renders a tool's result schema as its return type (Pi's codemode
 * lists direct tools that way within a fixed budget) needs field names, not the tree below them.
 */
const PRIMITIVE_TYPES = new Set(["string", "number", "boolean", "integer", "null"]);

/** Each top-level property keeps a primitive type; nested objects and arrays become "anything". */
export const summariseResultSchema = (
  schema: { readonly [key: string]: unknown } | undefined,
): { readonly [key: string]: unknown } | undefined => {
  const properties = schema?.["properties"];
  if (schema === undefined || typeof properties !== "object" || properties === null) return schema;
  const summarised: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const type =
      typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
    summarised[key] = typeof type === "string" && PRIMITIVE_TYPES.has(type) ? { type } : {};
  }
  return {
    type: "object",
    properties: summarised,
    ...(Array.isArray(schema["required"]) ? { required: schema["required"] } : {}),
  };
};
