import { expect, it } from "@effect/vitest";

import { buildServerProvider } from "./snapshotProbe.ts";

it("preserves a declared read-only boundary and leaves unknown providers unenforced", () => {
  const snapshot = (readOnlySourceAccess?: "enforced") =>
    buildServerProvider({
      presentation: {
        displayName: "Test",
        toolCallGuard: "blocking",
        ...(readOnlySourceAccess === undefined ? {} : { readOnlySourceAccess }),
      },
      enabled: true,
      checkedAt: "2026-10-27T00:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  expect(snapshot("enforced").readOnlySourceAccess).toBe("enforced");
  expect(snapshot().readOnlySourceAccess).toBeUndefined();
});

it("reports native web research only when a provider declares it", () => {
  const snapshot = (nativeWebResearch?: boolean) =>
    buildServerProvider({
      presentation: {
        displayName: "Test",
        toolCallGuard: "blocking",
        ...(nativeWebResearch === undefined ? {} : { nativeWebResearch }),
      },
      enabled: true,
      checkedAt: "2026-10-27T00:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  expect(snapshot(true).nativeWebResearch).toBe(true);
  expect(snapshot(false).nativeWebResearch).toBe(false);
  expect(snapshot().nativeWebResearch).toBeUndefined();
});
