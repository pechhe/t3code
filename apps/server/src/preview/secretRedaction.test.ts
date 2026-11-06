import { describe, expect, it } from "@effect/vitest";

import { REDACTED_LOGIN, redactDeep, redactText, secretForms } from "./secretRedaction.ts";

describe("saved login redaction", () => {
  const forms = secretForms(["Super Secret <&'\"> pw"]);

  it("replaces the literal value and each encoded form a page or log may show", () => {
    for (const shown of [
      "Super Secret <&'\"> pw",
      "Super Secret <&'\\\"> pw",
      "Super%20Secret%20%3C%26'%22%3E%20pw",
      "Super+Secret+%3C%26'%22%3E+pw",
      "Super Secret &lt;&amp;&#39;&quot;&gt; pw",
      "Super Secret &lt;&amp;&#x27;&quot;&gt; pw",
    ])
      expect(redactText(`before ${shown} after`, forms)).toBe(`before ${REDACTED_LOGIN} after`);
    expect(
      redactText("Super   Secret <&'\">   pw", secretForms(["Super   Secret <&'\">   pw"])),
    ).toBe(REDACTED_LOGIN);
  });

  it("walks every string of a reply, leaving an image's data alone", () => {
    const reply = {
      url: "https://site.test/?pw=Super+Secret+%3C%26'%22%3E+pw",
      consoleEntries: [{ text: "typed Super Secret <&'\"> pw" }],
      screenshot: { data: "Super Secret <&'\"> pw" },
    };
    expect(redactDeep(reply, forms)).toEqual({
      url: `https://site.test/?pw=${REDACTED_LOGIN}`,
      consoleEntries: [{ text: `typed ${REDACTED_LOGIN}` }],
      screenshot: { data: "Super Secret <&'\"> pw" },
    });
    expect(redactDeep(reply, [])).toBe(reply);
  });
});
