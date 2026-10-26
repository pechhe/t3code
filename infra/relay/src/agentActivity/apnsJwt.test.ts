// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node verifies ES256 independently of the noble signer.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { makeApnsJwt } from "./apnsJwt.ts";

describe("APNs JWT signing", () => {
  it.effect("produces deterministic compact ES256 tokens accepted by Node crypto", () =>
    Effect.gen(function* () {
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      const input = {
        teamId: "test-team",
        keyId: "test-key",
        privateKey: Redacted.make(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
        issuedAtUnixSeconds: 1_700_000_000,
      };
      const jwt = yield* makeApnsJwt(input);
      expect(yield* makeApnsJwt(input)).toBe(jwt);
      const [header = "", payload = "", signature = ""] = jwt.split(".");
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: "test-key",
      });
      expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
        iss: "test-team",
        iat: input.issuedAtUnixSeconds,
      });
      const bytes = Buffer.from(signature, "base64url");
      expect(bytes).toHaveLength(64);
      expect(
        NodeCrypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          bytes,
        ),
      ).toBe(true);
      expect(
        NodeCrypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}-tampered`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          bytes,
        ),
      ).toBe(false);
    }),
  );
});
