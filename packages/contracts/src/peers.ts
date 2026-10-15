import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Whether a linked environment answered its last probe. `unsupported` means it
 * answered but runs a build that lacks what a peer needs.
 */
export const PeerEnvironmentStatus = Schema.Literals([
  "ok",
  "offline",
  "timeout",
  "unauthorized",
  "unsupported",
]);
export type PeerEnvironmentStatus = typeof PeerEnvironmentStatus.Type;

/** An environment this one reads threads from. Its credential never leaves the server. */
export const PeerEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** Base URLs tried in order. */
  routes: Schema.Array(TrimmedNonEmptyString),
  /** Absent when the list was not asked to probe and nothing has checked this peer yet. */
  status: Schema.optionalKey(PeerEnvironmentStatus),
  linkedAt: Schema.DateTimeUtc,
});
export type PeerEnvironment = typeof PeerEnvironment.Type;

/**
 * Links or unlinks one environment. `link` carries a one-time pairing code
 * that holds `orchestration:read` on the environment to link, with the routes
 * this server should try it over.
 */
export const PeersUpdateInput = Schema.Union([
  Schema.TaggedStruct("link", {
    code: TrimmedNonEmptyString,
    routes: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
  Schema.TaggedStruct("unlink", { environmentId: EnvironmentId }),
]);
export type PeersUpdateInput = typeof PeersUpdateInput.Type;

/**
 * `probe: false` lists the links with their last known status and contacts no peer. A client that
 * only needs to know what is linked, such as a composer, must not make opening a thread reach
 * other servers.
 */
export const PeersListInput = Schema.Struct({ probe: Schema.optionalKey(Schema.Boolean) });
export type PeersListInput = typeof PeersListInput.Type;

export const PeersListResult = Schema.Array(PeerEnvironment);
export type PeersListResult = typeof PeersListResult.Type;

export class PeerEnvironmentError extends Schema.TaggedError<PeerEnvironmentError>()(
  "PeerEnvironmentError",
  {
    reason: Schema.Literals([
      "self_link",
      "unreachable",
      "rejected",
      "not_linked",
      "unsupported",
      "storage",
    ]),
    environmentId: Schema.optional(EnvironmentId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "self_link":
        return "An environment cannot be linked to itself.";
      case "unreachable":
        return "The other environment did not answer on any route.";
      case "rejected":
        return "The other environment rejected the pairing code.";
      case "not_linked":
        return "That environment is not linked.";
      case "unsupported":
        return "The other environment runs a version that cannot be linked.";
      case "storage":
        return "The link could not be saved.";
    }
  }
}
