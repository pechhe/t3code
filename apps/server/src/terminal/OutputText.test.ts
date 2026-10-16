import { describe, expect, it } from "vite-plus/test";

import { terminalOutputText } from "./OutputText.ts";

describe("terminalOutputText", () => {
  it("shows the text a screen would show", () => {
    const history =
      "\u001b[1m$ \u001b[0mnpm i\r\n" +
      "progress 10%\rprogress 100%\r\n" +
      "typo\b\b\bes\r\n" +
      "\u0007done   \r\n\r\n";
    expect(terminalOutputText(history, 100)).toEqual({
      text: "$ npm i\nprogress 100%\nteso\ndone",
      truncated: false,
    });
  });

  it("applies line erases and cursor moves before dropping formatting", () => {
    const history =
      "Downloading package\r\u001b[2KDone\r\n" +
      "abcdef\u001b[3D\u001b[KX\r\n" +
      "abc\u001b[2CZ\u001b[1GY\r\n" +
      "\u001b]0;title\u0007\u001b[31mred\u001b[0m\r\n";
    expect(terminalOutputText(history, 100).text).toBe("Done\nabcX\nYbc  Z\nred");
  });

  it("keeps the newest lines and reports what it left out", () => {
    expect(terminalOutputText("one\ntwo\nthree\n", 2)).toEqual({
      text: "two\nthree",
      truncated: true,
    });
    const long = terminalOutputText("x".repeat(70_000), 10);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(64 * 1024);
  });
});
