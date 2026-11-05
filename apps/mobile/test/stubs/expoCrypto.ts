// @effect-diagnostics nodeBuiltinImport:off - a Node stand-in for expo-crypto has no Effect equivalent.
/// <reference types="node" />
import * as NodeCrypto from "node:crypto";

/** Node stand-in for expo-crypto: its native digest/random bindings do not exist here. */
export const CryptoDigestAlgorithm = {
  MD5: "MD5",
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA384: "SHA-384",
  SHA512: "SHA-512",
} as const;

const nodeAlgorithm = (algorithm: string): string => algorithm.toLowerCase().replace("-", "");

export const randomUUID = (): string => NodeCrypto.randomUUID();
export const getRandomBytes = (byteCount: number): Uint8Array =>
  new Uint8Array(NodeCrypto.randomBytes(byteCount));
export const getRandomBytesAsync = async (byteCount: number): Promise<Uint8Array> =>
  getRandomBytes(byteCount);
export const digest = async (algorithm: string, data: Uint8Array): Promise<ArrayBuffer> => {
  const value = NodeCrypto.createHash(nodeAlgorithm(algorithm)).update(data).digest();
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
};
export const digestStringAsync = async (
  algorithm: string,
  data: string,
  options?: { readonly encoding?: "base64" | "hex" },
): Promise<string> =>
  NodeCrypto.createHash(nodeAlgorithm(algorithm))
    .update(data, "utf8")
    .digest(options?.encoding === "base64" ? "base64" : "hex");
