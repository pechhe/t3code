// @ts-nocheck -- vendored pi-blackhole source, type-checked upstream under its own settings.
// T3 replacement for upstream's provider-stream.ts: T3's text generation owns transport, so
// the agents' fetch and stream hooks are inert.
export type ProviderFetchOption = { fetch?: typeof fetch };

export function createProviderFetch(_timeoutMs?: number): typeof fetch | undefined {
  return undefined;
}

export function createBridgeStreamFn(streamFn: Function, _modelRegistry?: unknown): Function {
  return streamFn;
}

export function neverThrow(streamFn: Function): (...args: any[]) => any {
  return (...args: any[]) => streamFn(...args);
}
