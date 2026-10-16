import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as HqAgentConnections from "./HqAgentConnections.ts";

/** HQ's MCP is stateless Streamable HTTP and serves only POST, so nothing else is forwarded. */
export const layer = HttpRouter.add(
  "*",
  HqAgentConnections.HQ_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST")
      return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
    const connections = yield* HqAgentConnections.HqAgentConnections;
    const body = yield* request.arrayBuffer;
    const response = yield* connections.forward({
      authorization: request.headers.authorization,
      body: new Uint8Array(body),
      contentType: request.headers["content-type"],
      accept: request.headers.accept,
      protocolVersion: request.headers["mcp-protocol-version"],
    });
    return HttpServerResponse.uint8Array(response.body, {
      status: response.status,
      ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
    });
  }).pipe(
    Effect.catchTag("HttpServerError", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    ),
  ),
);
