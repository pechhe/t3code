import { type DecisionRoutingFailureCode } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import { decodeResponse, encodeRequest } from "../decisions/adapters.ts";
import { request } from "../decisions/decisions.testkit.ts";
import responses from "../decisions/responses.test-fixture.json" with { type: "json" };
import * as BitwardenSecrets from "../secrets/BitwardenSecrets.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DecisionRouter from "./DecisionRouter.ts";

const { engine: _engine, ...routing } = request();
const reference = { provider: "1password", reference: "op://Vault/Decision/key" } as never;

const setup = (
  options: {
    settings?: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0];
    environment?: Record<string, string>;
    bitwarden?: string;
    bitwardenFailures?: number;
    secret?: string;
    status?: number;
    body?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const bitwardenReads: string[] = [];
    const http = HttpClient.make((req) =>
      Effect.sync(() => {
        calls.push({
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(
            new TextDecoder().decode(
              (req.body as unknown as { body: Uint8Array }).body ?? new Uint8Array(),
            ) || "null",
          ),
        });
        const wire = req.url.includes("openai") ? 1 : 0;
        const openrouter = req.url.includes("openrouter");
        const base = responses[wire] as Record<string, unknown>;
        const sent = JSON.stringify(calls.at(-1)?.body);
        if (sent.includes('"works"'))
          return HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify(
                wire === 1
                  ? {
                      answers: [{ name: "works", type: "predicate", probability: 0.5 }],
                      usage: { input_tokens: 40 },
                    }
                  : {
                      answers: { works: { type: "noul", noul: 0.5 } },
                      usage: { input_tokens: 40 },
                    },
              ),
              { status: options.status ?? 200 },
            ),
          );
        const body = openrouter
          ? {
              ...base,
              usage: { ...(base.usage as object), cost: 0.000123 },
            }
          : base;
        return HttpClientResponse.fromWeb(
          req,
          new Response(options.body ?? JSON.stringify(body), { status: options.status ?? 200 }),
        );
      }),
    );
    const service = yield* DecisionRouter.DecisionRouter.pipe(
      Effect.provide(
        DecisionRouter.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, http),
              ServerSettings.ServerSettingsService.layerTest(options.settings ?? {}),
              Layer.mock(SecretResolver.SecretResolver)({
                read: () => Effect.succeed([options.secret ?? ""]),
                invalidate: () => Effect.void,
                label: () => Effect.succeed("1Password"),
              }),
              Layer.mock(BitwardenSecrets.BitwardenSecrets)({
                read: (key) =>
                  Effect.suspend(() => {
                    bitwardenReads.push(key);
                    if (bitwardenReads.length <= (options.bitwardenFailures ?? 0))
                      return Effect.fail(
                        new BitwardenSecrets.BitwardenSecretsError({
                          reason: "failed",
                          cause: new Error("429"),
                        }),
                      );
                    return Effect.succeed(
                      options.bitwarden ? Option.some(options.bitwarden) : Option.none<string>(),
                    );
                  }),
              }),
              NodeCrypto.layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown(options.environment ?? {})),
            ),
          ),
        ),
      ),
    );
    return { service, calls, bitwardenReads };
  });

const failure = (code: DecisionRoutingFailureCode) => expect.objectContaining({ code });

it.effect("sends Jev the same request bytes and returns the same answers as the engine path", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({
      settings: { decisionCredentials: { jev: "jev-key-1234" } },
    });
    const result = yield* service.decide(routing);
    expect(calls[0]).toEqual({
      url: "https://api.typesafe.ai/v1/systemone",
      authorization: "Bearer jev-key-1234",
      body: JSON.parse(JSON.stringify(encodeRequest(request("jev")))),
    });
    expect(result.provider).toBe("jev");
    expect(result.requestedModel).toBe("jev-1.14.0");
    expect(result.cost.status).toBe("estimated");
    expect(result.answers).toEqual(decodeResponse(request("jev"), responses[0]).answers);
  }),
);

it.effect("routes OpenAI through the Decisions endpoint with its own wire shape", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({
      settings: { decisionProvider: "openai", decisionCredentials: { openai: "sk-openai-1234" } },
    });
    const result = yield* service.decide(routing);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/decisions");
    expect(calls[0]?.body).toEqual(JSON.parse(JSON.stringify(encodeRequest(request("luna")))));
    expect(result.provider).toBe("openai");
  }),
);

it.effect("sends OpenRouter the Jev wire format with the chosen model and reports its cost", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({
      settings: {
        decisionProvider: "openrouter",
        decisionOpenRouterModel: "typesafe/jev-1.14.0",
        decisionCredentials: { openrouter: "or-key-1234" },
      },
    });
    const result = yield* service.decide(routing);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(calls[0]?.body).toEqual({
      ...JSON.parse(JSON.stringify(encodeRequest(request("jev")))),
      model: "typesafe/jev-1.14.0",
    });
    expect(result.requestedModel).toBe("typesafe/jev-1.14.0");
    expect(result.cost).toMatchObject({ usd: 0.000123, status: "reported" });
  }),
);

it.effect("refuses a request that still names an engine", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* setup({ settings: { decisionCredentials: { jev: "k" } } });
    const error = yield* Effect.flip(service.decide(request("luna")));
    expect(error).toEqual(
      expect.objectContaining({ code: "engine-not-accepted", provider: "jev" }),
    );
    expect(calls).toEqual([]);
  }),
);

it.effect("names the provider and cause for each failure and never falls back", () =>
  Effect.gen(function* () {
    const cases: Array<[number, DecisionRoutingFailureCode]> = [
      [401, "key-rejected"],
      [402, "credits-exhausted"],
      [429, "rate-limited"],
      [500, "unreachable"],
    ];
    for (const [status, code] of cases) {
      const { service, calls } = yield* setup({
        settings: { decisionCredentials: { jev: "jev-key-1234", openai: "sk-1234567" } },
        status,
        body: "{}",
      });
      const error = yield* Effect.flip(service.decide(routing));
      expect(error).toEqual(failure(code));
      expect(error.message).toContain("Jev (TypeSafe)");
      expect(calls).toHaveLength(1);
    }
    const { service } = yield* setup({
      settings: { decisionCredentials: { jev: "k" } },
      body: "{",
    });
    expect(yield* Effect.flip(service.decide(routing))).toEqual(
      failure("invalid-provider-response"),
    );
  }),
);

it.effect("fails when no key is set and when a saved reference cannot be read", () =>
  Effect.gen(function* () {
    const missing = yield* setup();
    expect(yield* Effect.flip(missing.service.decide(routing))).toEqual(failure("key-missing"));
    expect(missing.calls).toEqual([]);
    const unreadable = yield* setup({
      settings: { decisionCredentials: { jev: reference } },
      environment: { TYPESAFE_API_KEY: "env-key-should-not-be-used" },
      secret: "",
    });
    expect(yield* Effect.flip(unreadable.service.decide(routing))).toEqual(
      failure("key-unreadable"),
    );
    expect(unreadable.calls).toEqual([]);
  }),
);

it.effect("resolves a key from a reference, then the server environment, then Bitwarden", () =>
  Effect.gen(function* () {
    const viaReference = yield* setup({
      settings: { decisionCredentials: { jev: reference } },
      secret: "reference-key-9999",
    });
    yield* viaReference.service.decide(routing);
    expect(viaReference.calls[0]?.authorization).toBe("Bearer reference-key-9999");
    const viaEnvironment = yield* setup({ environment: { TYPESAFE_API_KEY: "env-key-5555" } });
    yield* viaEnvironment.service.decide(routing);
    expect(viaEnvironment.calls[0]?.authorization).toBe("Bearer env-key-5555");
    const viaBitwarden = yield* setup({ bitwarden: "bitwarden-key-7777" });
    expect((yield* viaBitwarden.service.status).keys.jev).toEqual({
      source: "bitwarden",
      last4: "7777",
    });
  }),
);

it.effect("reads the Bitwarden Jev key once for repeated decisions and retries a failed read", () =>
  Effect.gen(function* () {
    const shared = yield* setup({ bitwarden: "bitwarden-key-7777" });
    for (let attempt = 0; attempt < 3; attempt++) yield* shared.service.decide(routing);
    expect(shared.bitwardenReads).toEqual(["TYPESAFE_API_KEY"]);
    expect(shared.calls.map((call) => call.authorization)).toEqual([
      "Bearer bitwarden-key-7777",
      "Bearer bitwarden-key-7777",
      "Bearer bitwarden-key-7777",
    ]);
    const flaky = yield* setup({ bitwarden: "bitwarden-key-7777", bitwardenFailures: 1 });
    yield* flaky.service.decide(routing).pipe(Effect.exit);
    yield* flaky.service.decide(routing);
    expect(flaky.bitwardenReads).toHaveLength(2);
    expect(flaky.calls).toHaveLength(1);
  }),
);

it.effect("reports each key's source and last four characters, never the key", () =>
  Effect.gen(function* () {
    const { service } = yield* setup({
      settings: { decisionCredentials: { jev: "jev-key-1234", openrouter: reference } },
      secret: "reference-key-9999",
      environment: { OPENAI_API_KEY: "sk-env-0000" },
    });
    const status = yield* service.status;
    expect(status.keys).toEqual({
      jev: { source: "setting", last4: "1234" },
      openai: { source: "server-environment", last4: "0000" },
      openrouter: { source: "reference", last4: "9999" },
    });
    expect(JSON.stringify(status)).not.toContain("jev-key");
  }),
);

it.effect("test runs one tiny decision and reports the outcome", () =>
  Effect.gen(function* () {
    const ok = yield* setup({ settings: { decisionCredentials: { jev: "jev-key-1234" } } });
    expect(yield* ok.service.test).toMatchObject({ provider: "jev", ok: true });
    const bad = yield* setup({
      settings: { decisionCredentials: { jev: "jev-key-1234" } },
      status: 402,
      body: "{}",
    });
    expect(yield* bad.service.test).toMatchObject({ ok: false, failure: "credits-exhausted" });
  }),
);
