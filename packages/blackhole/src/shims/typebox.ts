// Stand-in for the slice of TypeBox Blackhole's worker tool schemas use: it builds the same JSON
// Schema objects, which T3 shows the Utility model as the shape of its reply.
export type TSchema = Record<string, any>;
export type Static<_T> = any;
export type TUnsafe<_T> = TSchema;

const OPTIONAL = "__t3BlackholeOptional";

export const Type = {
  Object: (
    properties: Record<string, TSchema>,
    options: Record<string, unknown> = {},
  ): TSchema => ({
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const { [OPTIONAL]: _optional, ...schema } = value;
        return [key, schema];
      }),
    ),
    required: Object.entries(properties)
      .filter(([, value]) => value[OPTIONAL] !== true)
      .map(([key]) => key),
    ...options,
  }),
  Array: (items: TSchema, options: Record<string, unknown> = {}): TSchema => ({
    type: "array",
    items,
    ...options,
  }),
  String: (options: Record<string, unknown> = {}): TSchema => ({ type: "string", ...options }),
  Number: (options: Record<string, unknown> = {}): TSchema => ({ type: "number", ...options }),
  Boolean: (options: Record<string, unknown> = {}): TSchema => ({ type: "boolean", ...options }),
  Literal: (value: string): TSchema => ({ const: value, type: "string" }),
  Union: (anyOf: TSchema[]): TSchema => ({ anyOf }),
  Optional: (schema: TSchema): TSchema => ({ ...schema, [OPTIONAL]: true }),
  Unsafe: <_T>(schema: TSchema): TSchema => schema,
};
