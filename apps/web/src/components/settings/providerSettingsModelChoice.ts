/**
 * The config a model choice writes: the model slug plus the account that runs it. A pool-shared
 * field stores an explicit empty choice when cleared, so a member never falls back to the pool's
 * value without saying so.
 */
export function nextModelChoiceConfig(input: {
  readonly base: unknown;
  readonly modelKey: string;
  readonly instanceKey: string | undefined;
  readonly model: string;
  readonly instanceId: string;
}): Record<string, unknown> | undefined {
  const base = configRecord(input.base);
  return input.instanceKey === undefined
    ? { ...base, [input.modelKey]: input.model }
    : { ...base, [input.modelKey]: input.model, [input.instanceKey]: input.instanceId };
}

export function clearedModelChoiceConfig(input: {
  readonly base: unknown;
  readonly modelKey: string;
  readonly instanceKey: string | undefined;
  readonly storeEmptyChoice: boolean;
}): Record<string, unknown> | undefined {
  const base = configRecord(input.base);
  if (input.instanceKey !== undefined) delete base[input.instanceKey];
  if (input.storeEmptyChoice) base[input.modelKey] = "";
  else delete base[input.modelKey];
  return Object.keys(base).length === 0 ? undefined : base;
}

function configRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? { ...(value as Record<string, unknown>) }
    : {};
}
