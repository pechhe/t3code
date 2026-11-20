// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";

import { GrokSettings } from "@t3tools/provider-grok/settings";

import { checkGrokProviderStatus } from "@t3tools/provider-grok/testing";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("checkGrokProviderStatus", (it) => {
  it.effect("declares read-only enforcement even before a provider is enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(decodeGrokSettings({ enabled: false }));
      expect(snapshot.readOnlySourceAccess).toBe("enforced");
    }),
  );
});
