import { SecretValueInput } from "../secrets/SecretValueInput";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand, selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SavedSecretMetadata,
  SecretsListResult,
  TemporarySecretMetadata,
} from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState, type FormEvent } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const quiet = { reportFailure: false, reportDefect: false } as const;

export function SavedSecretInventory({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canList = useAtomValue(serverEnvironment.secretsList.permissionAtom(environmentId));
  const canSave = useAtomValue(serverEnvironment.secretsSave.permissionAtom(environmentId));
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [selected, setSelected] = useState<SavedSecretMetadata | "new" | null>(null);
  const inventoryAtom = serverEnvironment.secretsInventory({
    environmentId,
    input: { query: activeQuery },
  });
  const inventory = useAtomValue(inventoryAtom);
  const data = selectEnvironmentQueryData(inventory);
  const [pagination, setPagination] = useState<{
    readonly base: SecretsListResult;
    readonly entries: readonly SavedSecretMetadata[];
    readonly nextCursor: string | null;
  } | null>(null);
  const page = pagination?.base === data ? pagination : data;
  const entries = page?.entries ?? [];
  const projectId = data?.projectId ?? "";
  const cursor = page?.nextCursor ?? null;
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const loading = moreBusy || inventory.waiting || inventory._tag === "Initial";
  const error =
    moreError ??
    (inventory._tag === "Failure"
      ? data === null
        ? "Could not load saved secrets. Check Bitwarden access and try again."
        : "Could not refresh saved secrets. Showing the last loaded list."
      : null);
  const sequence = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discard outstanding pagination when this inventory unmounts
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );

  async function more() {
    if (cursor === null || loading || data === null) return;
    const request = ++sequence.current;
    setMoreBusy(true);
    setMoreError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.secretsList,
      { environmentId, input: { query: activeQuery, cursor } },
      quiet,
    );
    if (sequence.current !== request) return;
    setMoreBusy(false);
    if (result._tag === "Success") {
      setPagination({
        base: data,
        entries: [...entries, ...result.value.entries],
        nextCursor: result.value.nextCursor,
      });
    } else setMoreError("Could not load more secrets. Try again.");
  }

  if (!canList)
    return (
      <SettingsSection title="Saved in Bitwarden">
        <SettingsRow
          title="Permission required"
          description="This connection cannot manage saved secrets."
        />
      </SettingsSection>
    );
  return (
    <>
      <SettingsSection
        title="Bitwarden Secrets Manager"
        headerAction={
          canSave ? (
            <Button size="xs" variant="outline" onClick={() => setSelected("new")}>
              Add secret
            </Button>
          ) : null
        }
      >
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {projectId ? `Project: ${projectId}` : "Manage saved secrets for this environment."}
          </p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSelected(null);
              setPagination(null);
              setMoreError(null);
              if (query === activeQuery) registry.refresh(inventoryAtom);
              else setActiveQuery(query);
            }}
          >
            <Input
              aria-label="Search saved secrets"
              placeholder="Search by key name"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {loading && data === null ? (
            <p className="text-sm text-muted-foreground">Loading secrets…</p>
          ) : null}
          {inventory.waiting && data !== null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Refreshing secrets…
            </p>
          ) : null}
          {data !== null && !error && entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved secrets match this search.</p>
          ) : null}
        </div>
        {entries.map((entry) => (
          <SettingsRow
            key={entry.id}
            title={entry.key}
            description={entry.browserLogin ? "Browser login" : undefined}
            control={
              <Button size="xs" variant="outline" onClick={() => setSelected(entry)}>
                Manage
              </Button>
            }
          />
        ))}
        {cursor !== null ? (
          <div className="px-4 pb-3">
            <Button size="xs" variant="outline" disabled={loading} onClick={() => void more()}>
              Load more
            </Button>
          </div>
        ) : null}
      </SettingsSection>
      {selected !== null ? (
        <SecretDetails
          key={selected === "new" ? "new" : selected.id}
          environmentId={environmentId}
          entry={selected}
          projectId={projectId}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            setPagination(null);
            setMoreError(null);
          }}
        />
      ) : null}
    </>
  );
}

function SecretDetails({
  environmentId,
  projectId,
  entry,
  onClose,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: SavedSecretMetadata | "new";
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const canSave = useAtomValue(serverEnvironment.secretsSave.permissionAtom(environmentId));
  const canReveal = useAtomValue(serverEnvironment.secretsReveal.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.secretsDelete.permissionAtom(environmentId));
  const save = useAtomCommand(serverEnvironment.secretsSave, quiet);
  const reveal = useAtomCommand(serverEnvironment.secretsReveal, quiet);
  const remove = useAtomCommand(serverEnvironment.secretsDelete, quiet);
  const [mode, setMode] = useState<"view" | "new" | "rename" | "replace" | "delete">(
    entry === "new" ? "new" : "view",
  );
  const [key, setKey] = useState(entry === "new" ? "" : entry.key);
  const [secret, setSecret] = useState("");
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => randomUUID());
  const request = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidate in-flight reads when this panel unmounts
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );

  function changeMode(next: typeof mode) {
    request.current++;
    setValue(null);
    setSecret("");
    setError(null);
    setRequestId(randomUUID());
    setMode(next);
  }
  async function read(copy: boolean) {
    if (entry === "new" || busy) return;
    const current = ++request.current;
    setBusy(true);
    setError(null);
    const result = await reveal({ environmentId, input: { id: entry.id } });
    if (request.current !== current) return;
    setBusy(false);
    if (result._tag !== "Success") {
      setError("Could not read the secret. Check access and try again.");
      return;
    }
    if (copy) {
      try {
        await navigator.clipboard.writeText(result.value);
      } catch {
        setError("Could not copy the secret. Check clipboard access.");
      }
    } else setValue(result.value);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSave || !key.trim() || (mode !== "rename" && !secret.length)) return;
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId,
      input: {
        projectId: entry === "new" ? projectId : entry.projectId,
        ...(entry === "new" ? {} : { id: entry.id }),
        key,
        ...(mode === "rename" ? {} : { secret }),
        clientRequestId: requestId,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setSecret("");
      onChanged();
    } else
      setError(
        "Could not save the secret. Check Bitwarden before retrying if the outcome is uncertain.",
      );
  }
  async function deleteEntry() {
    if (entry === "new" || busy || !canDelete) return;
    setBusy(true);
    setError(null);
    const result = await remove({ environmentId, input: { id: entry.id } });
    setBusy(false);
    if (result._tag === "Success") onChanged();
    else setError("Could not delete the entry. Check access and try again.");
  }
  return (
    <SettingsSection
      title={entry === "new" ? "Add secret" : entry.key}
      headerAction={
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close secret
        </Button>
      }
    >
      <div className="space-y-3 px-4 py-3">
        {entry !== "new" && mode === "view" ? (
          <>
            <p className="text-xs text-muted-foreground">
              Bitwarden · {entry.projectId}
              {entry.browserLogin ? " · Browser login" : ""}
            </p>
            <p className="font-mono text-sm wrap-anywhere">{value ?? "••••••••••••"}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!canReveal || busy}
                onClick={() => (value === null ? void read(false) : setValue(null))}
              >
                {value === null ? "Reveal" : "Hide"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canReveal || busy}
                onClick={() => void read(true)}
              >
                Copy
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => changeMode("replace")}
              >
                Replace value
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => changeMode("rename")}
              >
                Rename
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canDelete || busy}
                onClick={() => changeMode("delete")}
              >
                Delete from Bitwarden
              </Button>
            </div>
          </>
        ) : null}
        {mode === "delete" ? (
          <>
            <p className="text-sm">
              Delete this entry from Bitwarden? Other apps may use it. This does not revoke the key
              at its issuing service.
            </p>
            <div className="flex gap-2">
              <Button variant="destructive" disabled={busy} onClick={() => void deleteEntry()}>
                Delete entry
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => changeMode("view")}>
                Keep secret
              </Button>
            </div>
          </>
        ) : null}
        {mode === "new" || mode === "rename" || mode === "replace" ? (
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            {mode !== "replace" ? (
              <label className="block space-y-1 text-sm">
                Key name
                <Input
                  value={key}
                  onChange={(event) => {
                    setKey(event.currentTarget.value);
                    setRequestId(randomUUID());
                  }}
                  autoComplete="off"
                />
              </label>
            ) : null}
            {mode !== "rename" ? (
              <label className="block space-y-1 text-sm">
                Secret value
                <SecretValueInput
                  value={secret}
                  onValueChange={(value) => {
                    setSecret(value);
                    setRequestId(randomUUID());
                  }}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {mode === "rename"
                ? "Apps and agents using the old name may stop working. Browser login prefixes cannot be changed."
                : "Saving does not rotate the key at the issuing service or restart apps using it."}
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !canSave}>
                Save to Bitwarden
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => (entry === "new" ? onClose() : changeMode("view"))}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}

export function TemporarySecretInventory({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const registry = useContext(RegistryContext);
  const canList = useAtomValue(
    serverEnvironment.secretsListTemporary.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.secretsRemoveTemporary.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.secretsRemoveTemporary, quiet);
  const [entries, setEntries] = useState<readonly TemporarySecretMetadata[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronize temporary handoffs with the environment
  useEffect(() => {
    let active = true;
    void runAtomCommand(
      registry,
      serverEnvironment.secretsListTemporary,
      { environmentId, input: {} },
      quiet,
    ).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setEntries(result.value);
        setError(null);
      } else setError("Could not load temporary handoffs. Try again.");
    });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- version explicitly refreshes external handoff metadata
  }, [registry, environmentId, version]);
  async function removeEntry(id: string) {
    if (!canRemove || removing !== null) return;
    setRemoving(id);
    const result = await remove({ environmentId, input: { id } });
    setRemoving(null);
    if (result._tag === "Success") setVersion((value) => value + 1);
    else setError("Could not remove the handoff. Try again.");
  }
  return (
    <SettingsSection title="Active temporary handoffs">
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        Held by this T3 environment. Never saved to Bitwarden.
      </p>
      {!canList ? (
        <SettingsRow title="Permission required" />
      ) : entries.length === 0 && !error ? (
        <SettingsRow title="No active temporary handoffs." />
      ) : (
        entries.map((entry) => (
          <SettingsRow
            key={entry.id}
            title={entry.label}
            description={`${entry.threadId ?? "No thread"} · ${entry.delivery === "file" ? "Private file" : "One-use reference"} · Expires ${new Date(entry.expiresAt).toLocaleString()}`}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!canRemove || removing !== null}
                onClick={() => void removeEntry(entry.id)}
              >
                Remove
              </Button>
            }
          />
        ))
      )}
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        One-use references disappear when consumed. Private files remain until expiry or removal.
        Removing a handoff cannot erase a copy already used by a command.
      </p>
    </SettingsSection>
  );
}
