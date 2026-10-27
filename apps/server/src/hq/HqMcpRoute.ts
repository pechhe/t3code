import { WEAVE_NAMES } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as HqAgentConnections from "./HqAgentConnections.ts";

/** Weave's MCP serves only POST; both names share the same authenticated proxy. */
const forward = Effect.gen(function* () {
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
  Effect.catchTags({
    HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
  }),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("*", `/mcp/${WEAVE_NAMES.servers[0]}`, forward),
  HttpRouter.add("*", `/mcp/${WEAVE_NAMES.servers[1]}`, forward),
);
