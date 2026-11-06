import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** How long a model is passed over after its latest overload signal. */
export const PROVIDER_OVERLOAD_COOLDOWN_MS = 15 * 60 * 1_000;

/** Overload is a model's state on one account: the account's other models stay eligible. */
export const providerOverloadKey = (instanceId: ProviderInstanceId | string, model: string) =>
  `${instanceId}\u0000${model}`;

/** Each overloaded account and model, by key, with the epoch millisecond its cool-down ends. */
export type ProviderOverloadSnapshot = ReadonlyMap<string, number>;

export class ProviderOverloads extends Context.Service<
  ProviderOverloads,
  {
    readonly mark: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
    }) => Effect.Effect<void>;
    readonly current: Effect.Effect<ProviderOverloadSnapshot>;
  }
>()("t3/provider/ProviderOverloads") {}

// In memory only: a restart forgets an overload, and the next overloaded run marks it again.
export const layer = Layer.effect(
  ProviderOverloads,
  Effect.gen(function* () {
    const overloads = yield* Ref.make<ProviderOverloadSnapshot>(new Map());
    const unexpired = (snapshot: ProviderOverloadSnapshot, nowMs: number) =>
      new Map([...snapshot].filter(([, until]) => until > nowMs));
    return ProviderOverloads.of({
      mark: Effect.fn("ProviderOverloads.mark")(function* (input) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Ref.update(overloads, (snapshot) =>
          unexpired(snapshot, nowMs).set(
            providerOverloadKey(input.instanceId, input.model),
            nowMs + PROVIDER_OVERLOAD_COOLDOWN_MS,
          ),
        );
      }),
      current: Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        return unexpired(yield* Ref.get(overloads), nowMs);
      }),
    });
  }),
);
