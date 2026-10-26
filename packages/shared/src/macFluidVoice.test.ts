import { describe, expect, it } from "vite-plus/test";
import { parseFluidVoiceRecordingStatus } from "./macFluidVoice.ts";

describe("FluidVoice recording-status protocol", () => {
  it("distinguishes a recording from a ready app", () => {
    expect(parseFluidVoiceRecordingStatus("recording")).toBe(true);
    expect(parseFluidVoiceRecordingStatus("ready")).toBe(false);
  });

  it.each(["", "unavailable", "false"])(
    "rejects %j rather than treating it as a new recording",
    (status) => {
      expect(() => parseFluidVoiceRecordingStatus(status)).toThrow(
        "Unexpected FluidVoice recording status",
      );
    },
  );
});
