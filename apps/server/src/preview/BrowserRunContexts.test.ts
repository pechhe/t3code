import { expect, it } from "@effect/vitest";

import { BrowserRunContexts } from "./BrowserRunContexts.ts";

it("keeps page code and saved logins apart per run, and forgets a run that ends without a tab", async () => {
  const runs = new BrowserRunContexts();
  await runs.addInitScript("run-a", "window.a = 1;");
  expect(() => runs.useLogin("run-a")).toThrow("has run page code");
  runs.useLogin("run-b");
  expect(() => runs.usePageCode("run-b")).toThrow("after a saved login");
  await expect(runs.addInitScript("run-b", "window.b = 1;")).rejects.toThrow("after a saved login");

  runs.forget("run-a");
  runs.forget("run-b");
  // Nothing of either run is left: a new run under the same key starts clean.
  runs.useLogin("run-a");
  runs.usePageCode("run-b");
});
