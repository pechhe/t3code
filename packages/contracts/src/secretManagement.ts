import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SecretValue = Schema.String.check(Schema.isMinLength(1));
export const SecretStorage = Schema.Literals(["bws", "temporary"]);
export type SecretStorage = typeof SecretStorage.Type;
export const SavedSecretMetadata = Schema.Struct({
  id: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  browserLogin: Schema.Boolean,
});
export type SavedSecretMetadata = typeof SavedSecretMetadata.Type;
export const SecretsListInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type SecretsListInput = typeof SecretsListInput.Type;
export const SecretsListResult = Schema.Struct({
  projectId: Schema.String,
  entries: Schema.Array(SavedSecretMetadata),
  nextCursor: Schema.NullOr(Schema.String),
});
export type SecretsListResult = typeof SecretsListResult.Type;
export const SecretsSaveInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  id: Schema.optional(TrimmedNonEmptyString),
  key: TrimmedNonEmptyString,
  secret: Schema.optional(SecretValue),
  clientRequestId: TrimmedNonEmptyString,
});
export type SecretsSaveInput = typeof SecretsSaveInput.Type;
export const SecretIdInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const TemporarySecretMetadata = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  threadId: Schema.optional(ThreadId),
  delivery: Schema.Literals(["secretRef", "file"]),
  expiresAt: Schema.Number,
});
export type TemporarySecretMetadata = typeof TemporarySecretMetadata.Type;

const messages = {
  unavailable: "Bitwarden is unavailable. Check this environment's BWS setup and access token.",
  not_found: "That secret no longer exists in this environment's configured Bitwarden project.",
  ambiguous: "More than one secret has that name. Select a secret by its ID.",
  exists: "A secret already has that name. Select it explicitly to replace it.",
  protected: "Browser logins can only be used through the browser's saved-login binding.",
  invalid: "The secret operation is invalid.",
  destination_changed:
    "The configured Bitwarden project has changed. Reopen the request or refresh Settings before saving.",
  uncertain:
    "The Bitwarden write outcome is uncertain. Check the store before trying another write.",
} as const;
export class SecretManagementError extends Schema.TaggedError<SecretManagementError>()(
  "SecretManagementError",
  { reason: Schema.Literals(Object.keys(messages) as Array<keyof typeof messages>) },
) {
  override get message() {
    return messages[this.reason];
  }
}
