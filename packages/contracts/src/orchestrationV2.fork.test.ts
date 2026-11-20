import { describe, expect, it } from "@effect/vitest";

import { isProviderOverloadedFailureCode } from "./orchestrationV2.ts";

describe("isProviderOverloadedFailureCode", () => {
  it("recognises each provider's overload code and nothing else", () => {
    for (const code of ["overloaded", "serverOverloaded", "api_error_529"])
      expect(isProviderOverloadedFailureCode(code)).toBe(true);
    for (const code of ["api_error_429", "usageLimitExceeded", "rate_limit", "", null, undefined])
      expect(isProviderOverloadedFailureCode(code)).toBe(false);
  });
});
