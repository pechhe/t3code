import { runAtomCommand, selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useFocusEffect, useIsFocused } from "@react-navigation/native";
import type {
  EnvironmentId,
  SavedSecretMetadata,
  SecretsListResult,
  TemporarySecretMetadata,
} from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SecretValueInput } from "../../components/secrets/SecretValueInput";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";

const noInventory = Atom.make(AsyncResult.initial<SecretsListResult>());

const quiet = { reportFailure: false, reportDefect: false } as const;

export function SettingsSecretsRouteScreen(_props: StaticScreenProps<undefined>) {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const menu = useSettingsEnvironmentMenu();
  return (
    <SettingsScreen title="Secrets" menus={[menu]}>
      <ScrollView contentContainerClassName="gap-6 px-5 pt-4 pb-8">
        {selectedTargets.length === 0 ? (
          <Text>Connect an environment to manage its secrets.</Text>
        ) : null}
        {selectedTargets.map((target) =>
          target.serverConfig.secretManagement === true ? (
            <EnvironmentSecrets
              key={target.environmentId}
              environmentId={target.environmentId}
              label={target.label}
            />
          ) : (
            <SettingsSection key={target.environmentId} title={target.label}>
              <Text>Update this environment to manage secrets.</Text>
            </SettingsSection>
          ),
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentSecrets({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const registry = useContext(RegistryContext);
  const canManage = useAtomValue(serverEnvironment.secretsSave.permissionAtom(environmentId));
  const list = useAtomCommand(serverEnvironment.secretsList, quiet);
  const removeTemporary = useAtomCommand(serverEnvironment.secretsRemoveTemporary, quiet);
  const [tab, setTab] = useState<"saved" | "temporary">("saved");
  const [temporary, setTemporary] = useState<readonly TemporarySecretMetadata[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SavedSecretMetadata | "new" | null>(null);
  const focused = useIsFocused();
  const inventoryAtom = serverEnvironment.secretsInventory({
    environmentId,
    input: { query: search },
  });
  const inventory = useAtomValue(tab === "saved" && focused ? inventoryAtom : noInventory);
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
  const savedBusy = busy || inventory.waiting || inventory._tag === "Initial";
  const inventoryError =
    inventory._tag === "Failure"
      ? data === null
        ? "Could not load Bitwarden. Check this environment's access and retry."
        : "Could not refresh saved secrets. Showing the last loaded list."
      : null;
  const generation = useRef(0);
  useFocusEffect(
    useCallback(
      () => () => {
        generation.current++;
        setSelected(null);
        setBusy(false);
      },
      [],
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch temporary handoff metadata only while its screen is visible
  useEffect(() => {
    if (tab !== "temporary" || !focused) return;
    const request = ++generation.current;
    void runAtomCommand(
      registry,
      serverEnvironment.secretsListTemporary,
      { environmentId, input: {} },
      quiet,
    ).then((result) => {
      if (generation.current !== request) return;
      setBusy(false);
      if (result._tag === "Success") setTemporary(result.value);
      else setError("Could not load temporary handoffs.");
    });
    return () => {
      generation.current++;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- version explicitly refreshes external handoff metadata
  }, [registry, environmentId, tab, focused, version]);
  function searchSaved() {
    setPagination(null);
    setError(null);
    setSelected(null);
    if (query === search) registry.refresh(inventoryAtom);
    else setSearch(query);
  }
  async function more() {
    if (!cursor || savedBusy || data === null) return;
    const request = ++generation.current;
    setBusy(true);
    const result = await list({ environmentId, input: { query: search, cursor } });
    if (generation.current !== request) return;
    setBusy(false);
    if (result._tag === "Success") {
      setPagination({
        base: data,
        entries: [...entries, ...result.value.entries],
        nextCursor: result.value.nextCursor,
      });
    } else setError("Could not load more secrets.");
  }
  return (
    <SettingsSection title={label}>
      <View className="gap-3 p-4">
        <SegmentedControl
          selected={tab}
          options={[
            { value: "saved", label: "Saved in Bitwarden" },
            { value: "temporary", label: "Temporary" },
          ]}
          onSelect={(next) => {
            setSelected(null);
            setBusy(next === "temporary");
            setError(null);
            setTab(next);
          }}
        />
        {!canManage ? <Text>This connection cannot manage secrets.</Text> : null}
        {tab === "saved" ? (
          <>
            <TextInput
              accessibilityLabel="Search saved secrets"
              placeholder="Search by key name"
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              autoCapitalize="none"
              onSubmitEditing={searchSaved}
            />
            <Button label="Search" tone="secondary" onPress={searchSaved} />
            <Button
              label="Add secret"
              tone="secondary"
              disabled={!canManage}
              onPress={() => setSelected("new")}
            />
            {entries.map((entry) => (
              <Button
                key={entry.id}
                label={entry.key}
                tone="text"
                onPress={() => setSelected(entry)}
              />
            ))}
            {data !== null && !error && !inventoryError && entries.length === 0 ? (
              <Text>No saved secrets match this search.</Text>
            ) : null}
            {cursor ? (
              <Button
                label="Load more"
                tone="text"
                disabled={savedBusy}
                onPress={() => void more()}
              />
            ) : null}
          </>
        ) : (
          <>
            <Text>Held on {label}. Not saved to Bitwarden.</Text>
            {temporary.map((entry) => (
              <View key={entry.id} className="gap-2">
                <Text>{entry.label}</Text>
                <Text className="text-xs text-foreground-muted">
                  {entry.delivery === "file" ? "Private file" : "One-use reference"} · Expires{" "}
                  {new Date(entry.expiresAt).toLocaleString()}
                </Text>
                <Button
                  label="Remove"
                  tone="text"
                  disabled={!canManage || busy}
                  onPress={() => {
                    setBusy(true);
                    void removeTemporary({ environmentId, input: { id: entry.id } }).then(
                      (result) => {
                        if (result._tag !== "Success") setError("Could not remove this handoff.");
                        setBusy(false);
                        setVersion((v) => v + 1);
                      },
                    );
                  }}
                />
              </View>
            ))}
            {!busy && temporary.length === 0 ? <Text>No active temporary handoffs.</Text> : null}
            <Text className="text-xs text-foreground-muted">
              One-use references disappear when consumed. Private files expire after 24 hours.
              Removal cannot erase copies already used by a command.
            </Text>
          </>
        )}
        {(tab === "saved" ? savedBusy && data === null : busy) ? <Text>Loading…</Text> : null}
        {tab === "saved" && inventory.waiting && data !== null ? (
          <Text>Refreshing secrets…</Text>
        ) : null}
        {error || (tab === "saved" && inventoryError) ? (
          <Text accessibilityRole="alert">{error ?? inventoryError}</Text>
        ) : null}
        <Button
          label="Refresh"
          tone="text"
          disabled={tab === "saved" ? savedBusy : busy}
          onPress={() => {
            setError(null);
            if (tab === "saved") registry.refresh(inventoryAtom);
            else {
              setBusy(true);
              setVersion((v) => v + 1);
            }
          }}
        />
        {selected ? (
          <SecretEditor
            key={selected === "new" ? "new" : selected.id}
            environmentId={environmentId}
            entry={selected}
            projectId={projectId}
            close={() => setSelected(null)}
            changed={() => {
              setSelected(null);
              setPagination(null);
              setError(null);
            }}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function SecretEditor({
  environmentId,
  projectId,
  entry,
  close,
  changed,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: SavedSecretMetadata | "new";
  readonly projectId: string;
  readonly close: () => void;
  readonly changed: () => void;
}) {
  const save = useAtomCommand(serverEnvironment.secretsSave, quiet);
  const reveal = useAtomCommand(serverEnvironment.secretsReveal, quiet);
  const remove = useAtomCommand(serverEnvironment.secretsDelete, quiet);
  const canReveal = useAtomValue(serverEnvironment.secretsReveal.permissionAtom(environmentId));
  const canSave = useAtomValue(serverEnvironment.secretsSave.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.secretsDelete.permissionAtom(environmentId));
  const [mode, setMode] = useState<"view" | "new" | "rename" | "replace">(
    entry === "new" ? "new" : "view",
  );
  const [key, setKey] = useState(entry === "new" ? "" : entry.key);
  const [secret, setSecret] = useState("");
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const receipt = useRef(uuidv4());
  const generation = useRef(0);
  useFocusEffect(
    useCallback(
      () => () => {
        generation.current++;
        setValue(null);
        setSecret("");
      },
      [],
    ),
  );
  function change(next: typeof mode) {
    generation.current++;
    setValue(null);
    setSecret("");
    setError(null);
    receipt.current = uuidv4();
    setMode(next);
  }
  async function read(copy: boolean) {
    if (entry === "new" || busy || !canReveal) return;
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    const result = await reveal({ environmentId, input: { id: entry.id } });
    if (generation.current !== request) return;
    setBusy(false);
    if (result._tag !== "Success") {
      setError("Could not read this secret.");
      return;
    }
    if (copy) await tryCopyTextWithHaptic(result.value);
    else setValue(result.value);
  }
  async function submit() {
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
        clientRequestId: receipt.current,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setSecret("");
      changed();
    } else
      setError("Could not save. If the outcome is uncertain, check Bitwarden before retrying.");
  }
  function deleteEntry() {
    if (entry === "new" || busy || !canDelete) return;
    Dialog.confirm({
      title: "Delete from Bitwarden?",
      message:
        "Other apps may use this entry. This does not revoke the key at its issuing service.",
      confirmText: "Delete entry",
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        void remove({ environmentId, input: { id: entry.id } }).then((result) => {
          setBusy(false);
          if (result._tag === "Success") changed();
          else setError("Could not delete the entry.");
        });
      },
    });
  }
  return (
    <View className="gap-3 border-t border-border pt-4">
      <Text>{entry === "new" ? "Add secret" : entry.key}</Text>
      <Text>Bitwarden project: {entry === "new" ? projectId : entry.projectId}</Text>
      {mode === "view" ? (
        <>
          <Text selectable={value !== null}>{value ?? "••••••••••••"}</Text>
          <Button
            label={value === null ? "Reveal" : "Hide"}
            tone="text"
            disabled={busy || !canReveal}
            onPress={() => (value === null ? void read(false) : setValue(null))}
          />
          <Button
            label="Copy"
            tone="text"
            disabled={busy || !canReveal}
            onPress={() => void read(true)}
          />
          <Button
            label="Replace value"
            tone="secondary"
            disabled={busy || !canSave}
            onPress={() => change("replace")}
          />
          <Button
            label="Rename"
            tone="text"
            disabled={busy || !canSave}
            onPress={() => change("rename")}
          />
          <Button
            label="Delete from Bitwarden"
            tone="text"
            disabled={busy || !canDelete}
            onPress={deleteEntry}
          />
        </>
      ) : (
        <>
          {mode !== "replace" ? (
            <TextInput
              accessibilityLabel="Key name"
              placeholder="Key name"
              value={key}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(text) => {
                setKey(text);
                receipt.current = uuidv4();
              }}
            />
          ) : null}
          {mode !== "rename" ? (
            <SecretValueInput
              accessibilityLabel="Secret value"
              placeholder="Secret value"
              value={secret}
              editable={!busy}
              onChangeText={(text) => {
                setSecret(text);
                receipt.current = uuidv4();
              }}
              onSubmitEditing={() => void submit()}
            />
          ) : null}
          <Text className="text-xs text-foreground-muted">
            {mode === "rename"
              ? "Consumers using the old name may stop working. Browser-login prefixes cannot change."
              : "Saved in Bitwarden until deleted. This does not rotate the key or restart apps using it."}
          </Text>
          <Button
            label="Save to Bitwarden"
            tone="primary"
            disabled={busy || !canSave}
            onPress={() => void submit()}
          />
          <Button
            label="Cancel"
            tone="text"
            disabled={busy}
            onPress={() => (entry === "new" ? close() : change("view"))}
          />
        </>
      )}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Button label="Close" tone="text" onPress={close} />
    </View>
  );
}
