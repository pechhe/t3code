import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type AccountId,
  type EnvironmentId,
  type PiAccount,
  type PiAccountFamily,
  type PiAccountLoginState,
  type PiAccountsSharedLogins,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { PooledModel } from "@t3tools/shared/accountPools";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { T, useGT, Var } from "gt-react";
import { ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNowMinute } from "../../hooks/useNowMinute";
import { LimitWindows } from "../usage/UsageLimits";
import { UsageSlotBudgetEditor } from "../usage/UsageSlotBudgetEditor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  groupPiAccounts,
  hasBudget,
  isSignInFamily,
  piAccountBadge,
  piAccountSlot,
  piProviderRegistered,
  PI_FAMILY_LABEL,
  previewPiProviderId,
  type PiCredentialGroup,
} from "./PiCredentials.logic";
import { AccountReserveControl } from "./AccountReserveControl";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SILENT = { reportFailure: false, reportDefect: false } as const;

function failureText(result: { readonly _tag: string }, fallback: string): string | null {
  if (result._tag !== "Failure") return null;
  if (isAtomCommandInterrupted(result as never)) return null;
  const failure = squashAtomCommandFailure(result as never);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/** Settings → Accounts: every Pi credential of each Pi instance here, with its reserve. */
export function PiCredentials({
  environmentId,
  providers,
  routedModels,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly routedModels: ReadonlyArray<PooledModel>;
}) {
  const piProviders = providers.filter((provider) => provider.driver === "pi");
  if (piProviders.length === 0) {
    return (
      <p className="px-4 text-sm text-muted-foreground">
        <T>This environment runs no Pi provider, so it has no Pi credentials to manage.</T>
      </p>
    );
  }
  return (
    <>
      {piProviders.map((provider) => (
        <PiInstanceCredentials
          key={provider.instanceId}
          environmentId={environmentId}
          provider={provider}
          showInstanceName={piProviders.length > 1}
          routedModels={routedModels}
        />
      ))}
    </>
  );
}

type Editing =
  | { readonly kind: "add" }
  | { readonly kind: "key"; readonly account: PiAccount }
  | { readonly kind: "budget"; readonly account: PiAccount }
  | { readonly kind: "remove"; readonly account: PiAccount };

function PiInstanceCredentials({
  environmentId,
  provider,
  showInstanceName,
  routedModels,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly showInstanceName: boolean;
  readonly routedModels: ReadonlyArray<PooledModel>;
}) {
  const gt = useGT();
  const instanceId = provider.instanceId;
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const query = useEnvironmentQuery(
    serverEnvironment.piAccounts({ environmentId, input: { instanceId } }),
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [flowId, setFlowId] = useState<string | null>(null);
  const accounts = query.data?.accounts ?? [];
  const groups = groupPiAccounts(accounts);
  const startLogin = useAtomCommand(serverEnvironment.startPiAccountLogin, SILENT);
  const [loginError, setLoginError] = useState<string | null>(null);
  const signIn = async (input: {
    readonly providerFamily: PiAccountFamily;
    readonly label: string;
    readonly providerId?: string;
  }) => {
    setLoginError(null);
    const result = await startLogin({ environmentId, input: { instanceId, ...input } });
    if (result._tag === "Success") {
      setFlowId(result.value.flowId);
      setEditing(null);
      return true;
    }
    setLoginError(failureText(result, gt("Pi's sign-in could not start.")));
    return false;
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
        <p className="min-w-0 text-sm text-muted-foreground">
          {showInstanceName ? `${provider.displayName ?? instanceId}: ` : ""}
          <T>
            Each account is its own Pi provider ID in this environment&apos;s Pi credentials (
            <code className="font-mono text-xs">auth.json</code>), used by T3 and terminal Pi alike.
          </T>
        </p>
        <Button
          size="xs"
          disabled={!canManage || editing?.kind === "add"}
          onClick={() => setEditing({ kind: "add" })}
        >
          <PlusIcon />
          <T>Add account</T>
        </Button>
      </div>
      {query.error ? <p className="px-4 text-sm text-destructive">{query.error}</p> : null}
      {(query.data?.sharedLogins ?? []).map((shared) => (
        <SharedLoginsNotice
          key={shared.providerFamily}
          environmentId={environmentId}
          instanceId={instanceId}
          shared={shared}
          disabled={!canManage}
        />
      ))}
      {editing?.kind === "add" ? (
        <AddAccountForm
          environmentId={environmentId}
          instanceId={instanceId}
          accounts={accounts}
          onSignIn={signIn}
          signInError={loginError}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {flowId === null ? null : (
        <LoginPanel
          environmentId={environmentId}
          instanceId={instanceId}
          flowId={flowId}
          onClose={() => setFlowId(null)}
        />
      )}
      {query.data === null ? (
        query.isPending ? (
          <p className="px-4 text-sm text-muted-foreground">
            <T>Reading Pi&apos;s credentials…</T>
          </p>
        ) : null
      ) : (
        groups.map((group) => (
          <CredentialGroup
            key={group.id}
            group={group}
            environmentId={environmentId}
            provider={provider}
            routedModels={routedModels}
            editing={editing}
            canManage={canManage}
            onEdit={setEditing}
            onSignIn={(account) =>
              void signIn({
                providerFamily: account.providerFamily,
                label: account.label,
                providerId: account.providerId,
              })
            }
          />
        ))
      )}
    </div>
  );
}

function SharedLoginsNotice({
  environmentId,
  instanceId,
  shared,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly shared: PiAccountsSharedLogins;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const separate = useAtomCommand(serverEnvironment.separatePiAccounts, SILENT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = shared.providerFamily === "antigravity" ? "Antigravity" : "Command Code";
  return (
    <SettingsRow
      title={gt(
        "{count, plural, =1 {{name} shares a login inside one provider} other {{name} shares {count} logins inside one provider}}",
        { count: shared.count, name },
      )}
      description={gt(
        "Pi switches between them itself when one runs out, so T3 cannot see or choose each one. Separating gives each its own provider ID; references to the old one move to the first.",
      )}
      status={error ?? undefined}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            const result = await separate({
              environmentId,
              input: { instanceId, providerFamily: shared.providerFamily },
            });
            setError(failureText(result, gt("T3 could not separate these logins.")));
            setPending(false);
          }}
        >
          {pending ? gt("Separating…") : gt("Separate logins")}
        </Button>
      }
    />
  );
}

function CredentialGroup({
  group,
  environmentId,
  provider,
  routedModels,
  editing,
  canManage,
  onEdit,
  onSignIn,
}: {
  readonly group: PiCredentialGroup;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly routedModels: ReadonlyArray<PooledModel>;
  readonly editing: Editing | null;
  readonly canManage: boolean;
  readonly onEdit: (editing: Editing | null) => void;
  readonly onSignIn: (account: PiAccount) => void;
}) {
  const gt = useGT();
  const count = group.accounts.length;
  return (
    <SettingsSection
      title={group.title}
      headerAction={
        <span className="text-xs text-muted-foreground tabular-nums">
          {gt("{count, plural, =1 {1 account in Pi} other {{count} accounts in Pi}}", { count })}
        </span>
      }
    >
      {count === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          <T>No accounts yet.</T>
        </p>
      ) : null}
      {group.accounts.map((account) => (
        <AccountRow
          key={account.providerId}
          account={account}
          environmentId={environmentId}
          provider={provider}
          routedModels={routedModels}
          editing={
            editing?.kind !== "add" && editing?.account.providerId === account.providerId
              ? editing
              : null
          }
          canManage={canManage}
          onEdit={onEdit}
          onSignIn={() => onSignIn(account)}
        />
      ))}
    </SettingsSection>
  );
}

function AccountRow({
  account,
  environmentId,
  provider,
  routedModels,
  editing,
  canManage,
  onEdit,
  onSignIn,
}: {
  readonly account: PiAccount;
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly routedModels: ReadonlyArray<PooledModel>;
  readonly editing: Exclude<Editing, { kind: "add" }> | null;
  readonly canManage: boolean;
  readonly onEdit: (editing: Editing | null) => void;
  readonly onSignIn: () => void;
}) {
  const gt = useGT();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const slot = piAccountSlot(provider, account.providerId);
  const badge = piAccountBadge(account, piProviderRegistered(provider, account.providerId));
  const budgetWindow = slot?.usageLimits.windows.find((window) => window.id === "budget");
  const signIn = isSignInFamily(account.providerFamily);
  // Routing names a Pi credential by its instance and provider ID.
  const accountId: AccountId = `${provider.instanceId}:${account.providerId}`;
  const environmentReserve = useEnvironmentSettings(
    environmentId,
    (settings) => settings.accountReserves?.[accountId]?.percent,
  );
  const scoped = useOptionalSettingsScope()?.target;
  const reserve = scoped
    ? scoped.settings.accountReserves?.[accountId]?.percent
    : environmentReserve;
  return (
    <SettingsRow
      title={account.label}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <code className="font-mono text-xs">{account.providerId}</code>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {account.email && account.email !== account.label ? <span>{account.email}</span> : null}
        </span>
      }
      control={
        <span className="flex items-center gap-1">
          {signIn ? (
            <Button size="xs" variant="outline" disabled={!canManage} onClick={onSignIn}>
              {account.status === "signedIn"
                ? gt("Re-auth")
                : gt("Sign in", { $context: "button, signs an account in" })}
            </Button>
          ) : account.providerFamily !== "other" || account.source === "auth" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canManage}
              onClick={() =>
                onEdit(hasBudget(account) ? { kind: "budget", account } : { kind: "key", account })
              }
            >
              {hasBudget(account) ? gt("Key & budget") : gt("Update key")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            disabled={!canManage}
            aria-label={gt("Remove {account}", { account: account.label })}
            onClick={() => onEdit({ kind: "remove", account })}
          >
            <XIcon />
          </Button>
        </span>
      }
    >
      <div className="mt-2 flex flex-col gap-2">
        {slot && slot.usageLimits.windows.length > 0 ? (
          <LimitWindows
            driver={provider.driver}
            accentColor={provider.accentColor}
            windows={slot.usageLimits.windows}
            now={now}
            reserve={reserve}
            compact
          />
        ) : slot?.spentUsd !== undefined ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            {gt("{spent} spent this month · set a monthly budget to track what is left", {
              spent: `$${slot.spentUsd.toFixed(2)}`,
            })}
          </p>
        ) : slot?.usageLimits.unavailable ? (
          <p className="text-xs text-muted-foreground">{slot.usageLimits.unavailable.message}</p>
        ) : null}
        <AccountReserveControl
          environmentId={environmentId}
          account={accountId}
          accountLabel={account.label}
          routedModels={routedModels}
          metered={(slot?.usageLimits.windows.length ?? 0) > 0}
          disabled={!canManage}
        />
        {editing?.kind === "key" || editing?.kind === "budget" ? (
          <KeyForm
            environmentId={environmentId}
            instanceId={provider.instanceId}
            account={account}
            onDone={() => onEdit(null)}
          />
        ) : null}
        {editing?.kind === "budget" ? (
          <UsageSlotBudgetEditor
            environmentId={environmentId}
            slotId={`${provider.instanceId}:${account.providerId}`}
            usedUsd={budgetWindow?.usedUsd}
            limitUsd={budgetWindow?.limitUsd}
          />
        ) : null}
        {editing?.kind === "remove" ? (
          <RemoveConfirm
            environmentId={environmentId}
            instanceId={provider.instanceId}
            account={account}
            onDone={() => onEdit(null)}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function KeyForm({
  environmentId,
  instanceId,
  account,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly account: PiAccount;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const save = useAtomCommand(serverEnvironment.savePiAccountKey, SILENT);
  const [label, setLabel] = useState(account.label);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border/70 p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await save({
          environmentId,
          input: {
            instanceId,
            providerId: account.providerId,
            providerFamily: account.providerFamily,
            label: label.trim() || account.label,
            key: key.trim(),
          },
        });
        setPending(false);
        const failure = failureText(result, gt("T3 could not save this key."));
        if (failure) setError(failure);
        else onDone();
      }}
    >
      <label className="flex min-w-40 flex-1 flex-col gap-1">
        <span className="text-3xs text-muted-foreground">
          <T>Name</T>
        </span>
        <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
      </label>
      <label className="flex min-w-56 flex-[2] flex-col gap-1">
        <span className="text-3xs text-muted-foreground">
          <T>New key (write-only; T3 never shows it again)</T>
        </span>
        <Input
          type="password"
          autoComplete="off"
          value={key}
          placeholder={
            account.source === "models"
              ? gt("Replaces the {file} key", { file: "models.json" })
              : gt("Paste the new key")
          }
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </label>
      <Button size="xs" type="submit" disabled={pending || key.trim().length === 0}>
        {pending ? gt("Saving…") : gt("Save key")}
      </Button>
      <Button size="xs" variant="ghost" type="button" disabled={pending} onClick={onDone}>
        <T>Cancel</T>
      </Button>
      {error ? <p className="basis-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

function RemoveConfirm({
  environmentId,
  instanceId,
  account,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly account: PiAccount;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const remove = useAtomCommand(serverEnvironment.removePiAccount, SILENT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-destructive/40 p-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        <T>
          Remove <Var>{account.label}</Var>? T3 deletes its credential from Pi on this environment;
          threads already running on it finish first.
        </T>
      </p>
      <Button
        size="xs"
        variant="destructive"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const result = await remove({
            environmentId,
            input: { instanceId, providerId: account.providerId },
          });
          setPending(false);
          const failure = failureText(result, gt("T3 could not remove this account."));
          if (failure) setError(failure);
          else onDone();
        }}
      >
        {pending ? gt("Removing…") : gt("Remove", { $context: "button, removes an account" })}
      </Button>
      <Button size="xs" variant="ghost" disabled={pending} onClick={onDone}>
        <T>Cancel</T>
      </Button>
      {error ? <p className="basis-full text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

const ADDABLE_FAMILIES: ReadonlyArray<PiAccountFamily> = [
  "claude-subscription",
  "anthropic-api",
  "openai-codex",
  "openai-api",
  "antigravity",
  "commandcode",
  "opencode-go",
  "other",
];

function AddAccountForm({
  environmentId,
  instanceId,
  accounts,
  onSignIn,
  signInError,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly accounts: ReadonlyArray<PiAccount>;
  readonly onSignIn: (input: {
    readonly providerFamily: PiAccountFamily;
    readonly label: string;
  }) => Promise<boolean>;
  readonly signInError: string | null;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const save = useAtomCommand(serverEnvironment.savePiAccountKey, SILENT);
  const [family, setFamily] = useState<PiAccountFamily>("opencode-go");
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState("");
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = isSignInFamily(family);
  const preview = previewPiProviderId(family, label, accounts);
  const ready =
    label.trim().length > 0 &&
    (signIn || key.trim().length > 0) &&
    (family !== "other" || /^[a-z0-9][a-z0-9._-]*$/.test(providerId.trim()));
  return (
    <SettingsSection title={gt("Add account")}>
      <form
        className="flex flex-col gap-3 p-3 sm:p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          if (signIn) {
            await onSignIn({ providerFamily: family, label: label.trim() });
            setPending(false);
            return;
          }
          const result = await save({
            environmentId,
            input: {
              instanceId,
              providerFamily: family,
              label: label.trim(),
              key: key.trim(),
              ...(family === "other" ? { providerId: providerId.trim() } : {}),
            },
          });
          setPending(false);
          const failure = failureText(result, gt("T3 could not add this account."));
          if (failure) setError(failure);
          else onDone();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-col gap-1">
            <span className="text-3xs text-muted-foreground">
              <T>Account type</T>
            </span>
            <Select
              value={family}
              onValueChange={(next) => next && setFamily(next as PiAccountFamily)}
            >
              <SelectTrigger aria-label={gt("Account type")}>
                <SelectValue>{PI_FAMILY_LABEL[family]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ADDABLE_FAMILIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {PI_FAMILY_LABEL[option]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-3xs text-muted-foreground">
              <T>Name</T>
            </span>
            <Input
              value={label}
              placeholder={
                family === "antigravity"
                  ? gt("The Google account, e.g. {example}", { example: "hfpetch" })
                  : gt("e.g. {example}", { example: "yardsmith" })
              }
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          {family === "other" ? (
            <label className="flex min-w-40 flex-col gap-1">
              <span className="text-3xs text-muted-foreground">
                <T>Pi provider ID</T>
              </span>
              <Input
                value={providerId}
                placeholder={gt("e.g. {example}", { example: "openrouter" })}
                onChange={(event) => setProviderId(event.currentTarget.value)}
              />
            </label>
          ) : null}
        </div>
        {signIn ? null : (
          <label className="flex flex-col gap-1">
            <span className="text-3xs text-muted-foreground">
              <T>Key (write-only; T3 never shows it again)</T>
            </span>
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
            />
          </label>
        )}
        <p className="text-xs text-muted-foreground">
          {preview === null ? (
            <T>Saved under the Pi provider ID you give.</T>
          ) : signIn ? (
            <T>
              Pi provider ID:{" "}
              <code className="font-mono">
                <Var>{preview}</Var>
              </code>{" "}
              · Sign-in opens in your browser, on this or another machine.
            </T>
          ) : (
            <T>
              Pi provider ID:{" "}
              <code className="font-mono">
                <Var>{preview}</Var>
              </code>
            </T>
          )}
        </p>
        {error || signInError ? (
          <p className="text-xs text-destructive">{error ?? signInError}</p>
        ) : null}
        <div className="flex gap-2">
          <Button size="xs" type="submit" disabled={pending || !ready}>
            {pending
              ? gt("Working…")
              : signIn
                ? gt("Sign in", { $context: "button, signs an account in" })
                : gt("Save account")}
          </Button>
          <Button size="xs" variant="ghost" type="button" disabled={pending} onClick={onDone}>
            <T>Cancel</T>
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}

const loginActive = (state: PiAccountLoginState | null) =>
  state !== null && (state.phase === "starting" || state.phase === "waiting");

function LoginPanel({
  environmentId,
  instanceId,
  flowId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly flowId: string;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.piAccountLogin({ environmentId, input: { instanceId, flowId } }),
  );
  const gt = useGT();
  const respond = useAtomCommand(serverEnvironment.respondPiAccountLogin, SILENT);
  const cancel = useAtomCommand(serverEnvironment.cancelPiAccountLogin, SILENT);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const remote = httpBaseUrl !== null && !isLoopbackHost(new URL(httpBaseUrl).hostname);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const state = query.data;
  const prompt = state?.prompt ?? null;
  const send = async (value: string) => {
    if (prompt === null) return;
    setError(null);
    const result = await respond({
      environmentId,
      input: { instanceId, flowId, promptId: prompt.id, value },
    });
    setError(failureText(result, gt("Pi did not take that answer.")));
    setAnswer("");
  };
  return (
    <SettingsSection
      title={state ? gt("Signing in {account}", { account: state.providerId }) : gt("Signing in")}
      headerAction={
        loginActive(state) ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void cancel({ environmentId, input: { instanceId, flowId } })}
          >
            <T>Cancel sign-in</T>
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={onClose}>
            <T>Close</T>
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 p-3 text-sm sm:p-4">
        {state === null ||
        (state.phase === "starting" && state.prompt === null && !state.authUrl) ? (
          <p className="text-muted-foreground">
            <T>Starting Pi&apos;s sign-in…</T>
          </p>
        ) : null}
        {state?.authUrl ? (
          <div className="flex flex-col items-start gap-1">
            <Button
              size="xs"
              variant="outline"
              render={<a href={state.authUrl} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
              <T>Open the sign-in page</T>
            </Button>
            {state.instructions ? (
              <p className="text-xs text-muted-foreground">{state.instructions}</p>
            ) : null}
            {remote ? (
              <p className="text-xs text-muted-foreground">
                <T>
                  This environment is another machine, so the page your browser lands on after
                  signing in may not load. Copy that address and paste it below.
                </T>
              </p>
            ) : null}
          </div>
        ) : null}
        {state?.deviceCode ? (
          <p className="text-xs text-muted-foreground">
            <T>
              Open{" "}
              <a className="underline" href={state.deviceCode.url} target="_blank" rel="noreferrer">
                <Var>{state.deviceCode.url}</Var>
              </a>{" "}
              and enter{" "}
              <code className="font-mono text-foreground">
                <Var>{state.deviceCode.userCode}</Var>
              </code>
              .
            </T>
          </p>
        ) : null}
        {prompt?.kind === "select" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{prompt.message}</p>
            <div className="flex flex-wrap gap-2">
              {prompt.options.map((option) => (
                <Button
                  key={option.id}
                  size="xs"
                  variant="outline"
                  onClick={() => void send(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        ) : prompt ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(answer);
            }}
          >
            <span className="text-xs text-muted-foreground">{prompt.message}</span>
            <div className="flex gap-2">
              <Input
                type={prompt.kind === "secret" ? "password" : "text"}
                autoComplete="off"
                value={answer}
                placeholder={prompt.placeholder ?? undefined}
                onChange={(event) => setAnswer(event.currentTarget.value)}
              />
              <Button size="xs" type="submit" disabled={answer.trim().length === 0}>
                <T>Continue</T>
              </Button>
            </div>
          </form>
        ) : null}
        {state?.message ? (
          <p
            className={
              state.phase === "failed"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {state.message}
          </p>
        ) : null}
        {error || query.error ? (
          <p className="text-xs text-destructive">{error ?? query.error}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
