import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Pi credentials of Settings → Accounts (fork/differences.md `pi-accounts`). One provider ID
 * names a credential in auth.json, model slugs, usage slots and routed account IDs
 * (`<instanceId>:<providerId>`); its family says who sells it and how its allowance is read.
 */
const PI_ACCOUNT_FAMILIES = [
  "claude-subscription",
  "anthropic-api",
  "openai-codex",
  "openai-api",
  "antigravity",
  "commandcode",
  "opencode-go",
  "other",
] as const;
export const PiAccountFamily = Schema.Literals(PI_ACCOUNT_FAMILIES);
export type PiAccountFamily = typeof PiAccountFamily.Type;

/** A Pi provider ID: lowercase, as Pi's auth.json keys and model slugs use it. */
export const PiProviderId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

export const PiAccount = Schema.Struct({
  providerId: PiProviderId,
  providerFamily: PiAccountFamily,
  label: TrimmedNonEmptyString,
  /** How it signs in; null when T3 lists it but holds no credential for it yet. */
  authType: Schema.NullOr(Schema.Literals(["oauth", "api_key"])),
  /** `expired`: an OAuth sign-in Pi can no longer refresh on its own. */
  status: Schema.Literals(["signedIn", "expired", "missing"]),
  /** The signed-in account, for OAuth logins that report one. Never a secret. */
  email: Schema.optionalKey(TrimmedNonEmptyString),
  /** `models`: its key comes from a models.json command, not auth.json. */
  source: Schema.Literals(["auth", "models"]),
  /** Listed in T3's registration file, so Pi registers it for T3. */
  managed: Schema.Boolean,
});
export type PiAccount = typeof PiAccount.Type;

/** Several logins Pi rotates between inside one provider, which T3 can split. */
export const PiAccountsSharedLogins = Schema.Struct({
  providerFamily: Schema.Literals(["antigravity", "commandcode"]),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type PiAccountsSharedLogins = typeof PiAccountsSharedLogins.Type;

export const PiAccountsState = Schema.Struct({
  instanceId: ProviderInstanceId,
  accounts: Schema.Array(PiAccount),
  sharedLogins: Schema.Array(PiAccountsSharedLogins),
});
export type PiAccountsState = typeof PiAccountsState.Type;

export const PiAccountsInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type PiAccountsInput = typeof PiAccountsInput.Type;

const AccountLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const PiAccountSaveKeyInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Omit to add a new account of `providerFamily`. */
  providerId: Schema.optionalKey(PiProviderId),
  providerFamily: PiAccountFamily,
  label: AccountLabel,
  /** Write-only: never sent back to any client. */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type PiAccountSaveKeyInput = typeof PiAccountSaveKeyInput.Type;

export const PiAccountRemoveInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  providerId: PiProviderId,
});
export type PiAccountRemoveInput = typeof PiAccountRemoveInput.Type;

export const PiAccountsSeparateInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  providerFamily: PiAccountsSharedLogins.fields.providerFamily,
});
export type PiAccountsSeparateInput = typeof PiAccountsSeparateInput.Type;

export const PiAccountLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Omit to sign in a new account of `providerFamily`; give it to sign an account in again. */
  providerId: Schema.optionalKey(PiProviderId),
  providerFamily: PiAccountFamily,
  label: AccountLabel,
});
export type PiAccountLoginStartInput = typeof PiAccountLoginStartInput.Type;

const FlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
// Environments supply these and clients open them, so a `javascript:` URL would run as the client.
const SignInUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^https?:\/\//i),
);

export const PiAccountLoginPrompt = Schema.Struct({
  id: FlowId,
  /** `manual_code`: a code or callback URL pasted from the browser, as on another machine. */
  kind: Schema.Literals(["text", "secret", "manual_code", "select"]),
  message: Schema.String.check(Schema.isMaxLength(2_000)),
  placeholder: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  options: Schema.Array(
    Schema.Struct({ id: FlowId, label: Schema.String.check(Schema.isMaxLength(200)) }),
  ).check(Schema.isMaxLength(16)),
});
export type PiAccountLoginPrompt = typeof PiAccountLoginPrompt.Type;

export const PiAccountLoginState = Schema.Struct({
  flowId: FlowId,
  instanceId: ProviderInstanceId,
  providerId: PiProviderId,
  phase: Schema.Literals(["starting", "waiting", "succeeded", "failed", "cancelled"]),
  authUrl: Schema.NullOr(SignInUrl),
  instructions: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  deviceCode: Schema.NullOr(
    Schema.Struct({
      url: SignInUrl,
      userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
  ),
  prompt: Schema.NullOr(PiAccountLoginPrompt),
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type PiAccountLoginState = typeof PiAccountLoginState.Type;

export const PiAccountLoginRespondInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: FlowId,
  promptId: FlowId,
  value: Schema.String.check(Schema.isMaxLength(16_384)),
});
export type PiAccountLoginRespondInput = typeof PiAccountLoginRespondInput.Type;

export const PiAccountLoginFlowInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: FlowId,
});
export type PiAccountLoginFlowInput = typeof PiAccountLoginFlowInput.Type;

/** Safe failure text: never a key, token, code or callback URL. */
export class PiAccountsError extends Schema.TaggedError<PiAccountsError>()("PiAccountsError", {
  instanceId: ProviderInstanceId,
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const PI_ACCOUNTS_WS_METHODS = {
  piAccountsList: "piAccounts.list",
  piAccountsSaveKey: "piAccounts.saveKey",
  piAccountsRemove: "piAccounts.remove",
  piAccountsSeparate: "piAccounts.separate",
  piAccountsLoginStart: "piAccounts.loginStart",
  piAccountsLoginRespond: "piAccounts.loginRespond",
  piAccountsLoginCancel: "piAccounts.loginCancel",
  piAccountsLoginSubscribe: "piAccounts.loginSubscribe",
} as const;

const PiAccountsRpcError = Schema.Union([PiAccountsError, EnvironmentAuthorizationError]);

export const WsPiAccountsRpcs = RpcGroup.make(
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsList, {
    payload: PiAccountsInput,
    success: PiAccountsState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsSaveKey, {
    payload: PiAccountSaveKeyInput,
    success: PiAccountsState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsRemove, {
    payload: PiAccountRemoveInput,
    success: PiAccountsState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsSeparate, {
    payload: PiAccountsSeparateInput,
    success: PiAccountsState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsLoginStart, {
    payload: PiAccountLoginStartInput,
    success: PiAccountLoginState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsLoginRespond, {
    payload: PiAccountLoginRespondInput,
    success: PiAccountLoginState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsLoginCancel, {
    payload: PiAccountLoginFlowInput,
    success: PiAccountLoginState,
    error: PiAccountsRpcError,
  }),
  Rpc.make(PI_ACCOUNTS_WS_METHODS.piAccountsLoginSubscribe, {
    payload: PiAccountLoginFlowInput,
    success: PiAccountLoginState,
    error: PiAccountsRpcError,
    stream: true,
  }),
);
