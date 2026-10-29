import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

/**
 * The request URL as the client addressed it. effect 4.0.6 stopped reading `x-forwarded-proto` in `toURL`, so behind a
 * TLS-terminating proxy (Tailscale serve, the T3 Connect tunnel) it reports `http://`. Only an upgrade to https is
 * taken from the header, never a downgrade.
 */
export const forwardedRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> =>
  Option.map(HttpServerRequest.toURL(request), (url) => {
    if (request.headers["x-forwarded-proto"]?.split(",")[0]?.trim().toLowerCase() === "https") {
      url.protocol = "https:";
    }
    return url;
  });
