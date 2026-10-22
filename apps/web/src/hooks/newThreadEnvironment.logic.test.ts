import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadEnvironmentId } from "./newThreadEnvironment.logic";

const local = EnvironmentId.make("local");
const peachBox = EnvironmentId.make("peach-box");

describe("resolveNewThreadEnvironmentId", () => {
  it("starts on the machine the composer's switch was last left on", () => {
    expect(
      resolveNewThreadEnvironmentId({
        remembered: peachBox,
        lastStarted: local,
        scratchEnvironmentIds: [local, peachBox],
      }),
    ).toBe(peachBox);
  });

  it("follows the newest thread when the switch has not been moved", () => {
    expect(
      resolveNewThreadEnvironmentId({
        remembered: null,
        lastStarted: peachBox,
        scratchEnvironmentIds: [local, peachBox],
      }),
    ).toBe(peachBox);
  });

  it("ignores a remembered machine that offers no scratch folder", () => {
    expect(
      resolveNewThreadEnvironmentId({
        remembered: peachBox,
        lastStarted: local,
        scratchEnvironmentIds: [local],
      }),
    ).toBe(local);
  });
});
