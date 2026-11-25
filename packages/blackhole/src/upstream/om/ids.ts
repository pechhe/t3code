// @ts-nocheck -- vendored pi-blackhole source, type-checked upstream under its own settings.
import { createHash } from "node:crypto";

export function hashId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
