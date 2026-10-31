import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { escapeHtml, shell } from "../auth/mcpOAuthHtml.ts";
import * as HqSignIn from "./HqSignIn.ts";
import { SIGN_IN_CALLBACK_PATH } from "./signInPath.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const RESULTS = {
  connected: ["T3 is connected to Weave", "You can close this page and return to T3."],
  cancelled: ["Connection cancelled", "T3 was not connected to Weave. You can close this page."],
  failed: [
    "T3 could not connect to Weave",
    "Close this page, then choose Connect to Weave in T3's Settings to try again.",
  ],
} as const;

const resultPage = (result: string) => {
  const [title, text] =
    result in RESULTS ? RESULTS[result as keyof typeof RESULTS] : RESULTS.failed;
  return HttpServerResponse.text(
    shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`),
    { contentType: "text/html; charset=utf-8", headers: PAGE_HEADERS },
  );
};

// Weave posts the code and state in a form body so neither enters the address bar or history.
const CALLBACK_BODY_MAX_BYTES = 1024;

const callbackParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "POST") return new URL(request.url, "http://localhost").searchParams;
  const body = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(CALLBACK_BODY_MAX_BYTES)),
    Effect.orElseSucceed(() => ""),
  );
  return new URLSearchParams(body);
});

/**
 * Weave's browser handback. The code and state are consumed here and the browser is redirected to the
 * same path without them, so neither stays in the address bar or history. The path needs no T3
 * session: only the state T3 issued for this environment, which is single use, completes a sign-in.
 */
const completeCallback = Effect.gen(function* () {
  const params = yield* callbackParams;
  const state = params.get("state") ?? undefined;
  const code = params.get("code") ?? undefined;
  const error = params.get("error") ?? undefined;
  if (state === undefined && code === undefined && error === undefined)
    return resultPage(params.get("result") ?? "failed");
  const signIn = yield* HqSignIn.HqSignIn;
  const outcome = yield* signIn.complete({ state, code, error });
  return HttpServerResponse.redirect(`${SIGN_IN_CALLBACK_PATH}?result=${outcome.status}`, {
    status: 303,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
});

export const layer = HttpRouter.addAll([
  HttpRouter.route("GET", SIGN_IN_CALLBACK_PATH, completeCallback),
  HttpRouter.route("POST", SIGN_IN_CALLBACK_PATH, completeCallback),
]);
