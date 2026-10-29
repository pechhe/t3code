import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import { forwardedRequestUrl } from "./forwardedUrl.ts";

const href = (headers: Record<string, string>) =>
  forwardedRequestUrl(
    HttpServerRequest.fromWeb(
      new Request("http://box.example.com/oauth/token", {
        headers: { host: "box.example.com", ...headers },
      }),
    ),
  ).pipe(Option.map((url) => url.href));

describe("forwardedRequestUrl", () => {
  it("takes https from a TLS-terminating proxy", () => {
    expect(href({ "x-forwarded-proto": "https" })).toEqual(
      Option.some("https://box.example.com/oauth/token"),
    );
  });

  it("never downgrades or trusts other values", () => {
    expect(href({})).toEqual(Option.some("http://box.example.com/oauth/token"));
    expect(href({ "x-forwarded-proto": "ftp" })).toEqual(
      Option.some("http://box.example.com/oauth/token"),
    );
  });
});
