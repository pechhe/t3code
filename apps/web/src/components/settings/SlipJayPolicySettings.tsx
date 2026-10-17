import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  SLIPJAY_MAX_SPARES,
  SlipJayCommandError,
  type EnvironmentId,
  type SlipJayProcessLevel,
  type VcsSlipJayProjectSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  describePolicyOutcome,
  describePolicyProgress,
  policyDraft,
  policyPatch,
  type SlipJayPolicyDraft,
} from "./SlipJaySettings.logic";

const PROCESS_LEVELS = {
  standard: "Standard",
  light: "Light",
} satisfies Record<SlipJayProcessLevel, string>;

const PROCESS_DESCRIPTIONS = {
  standard: "Agents review each change and challenge each Spec before building it.",
  light: "Agents skip review rounds and build a requested change directly, without a Spec.",
} satisfies Record<SlipJayProcessLevel, string>;

const NO_LIMIT = "none";

/**
 * A SlipJay project's shared policy, which `slipjay policy set` lands through the runner so
 * every machine and agent uses it, and this machine's spare limit for it. Hidden for a
 * project SlipJay does not manage.
 */
export function SlipJayPolicySettings({
  environmentId,
  cwd,
  machineLabel,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  /** The environment whose spares the machine row changes, named when the project spans several. */
  machineLabel: string | null;
}) {
  const { data: status } = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  if (!status?.slipJay) return null;
  return (
    <SlipJayPolicySection
      key={`${environmentId}:${cwd}`}
      environmentId={environmentId}
      cwd={cwd}
      machineLabel={machineLabel}
    />
  );
}

const isSlipJayCommandError = Schema.is(SlipJayCommandError);

function SlipJayPolicySection({
  environmentId,
  cwd,
  machineLabel,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  machineLabel: string | null;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.slipJayProjectSettings({ environmentId, input: { cwd } }),
  );
  const settings = query.data;
  // Outlives the form, which starts again when a save or a stale refusal moves the revision.
  const [outcome, setOutcome] = useState<PolicyOutcome | null>(null);
  // A server older than these settings cannot answer; only SlipJay's own failure is worth showing.
  if (!settings && query.error && !isSlipJayCommandError(query.failure)) return null;
  return (
    <SettingsSection {...searchableSetting("slipjay-policy")} title="SlipJay policy">
      {settings ? (
        <PolicyForm
          // A landed change or a policy moved elsewhere starts the form again from what is in force.
          key={settings.revision}
          environmentId={environmentId}
          cwd={cwd}
          settings={settings}
          machineLabel={machineLabel}
          outcome={outcome}
          onOutcome={setOutcome}
          onSaved={query.refresh}
        />
      ) : (
        <SettingsRow
          title={query.error ? "SlipJay policy could not be read" : "Reading SlipJay policy…"}
          description={query.error ?? undefined}
          control={
            query.error ? (
              <Button size="sm" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}

type PolicyOutcome = ReturnType<typeof describePolicyOutcome>;

function PolicyForm({
  environmentId,
  cwd,
  settings,
  machineLabel,
  outcome,
  onOutcome,
  onSaved,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  settings: VcsSlipJayProjectSettings;
  machineLabel: string | null;
  outcome: PolicyOutcome | null;
  onOutcome: (outcome: PolicyOutcome | null) => void;
  onSaved: () => void;
}) {
  const canEdit = useAtomValue(vcsEnvironment.slipJaySetPolicy.permissionAtom(environmentId));
  const setPolicy = useAtomCommand(vcsEnvironment.slipJaySetPolicy, { reportFailure: false });
  const [draft, setDraft] = useState<SlipJayPolicyDraft>(() => policyDraft(settings));
  const [saving, setSaving] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const { data: runner } = useEnvironmentQuery(
    following === null ? null : vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const update = (change: Partial<SlipJayPolicyDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    onOutcome(null);
  };
  const planned = policyPatch(settings, draft);
  const changed = "patch" in planned && Object.keys(planned.patch).length > 0;

  const save = async () => {
    if (!("patch" in planned)) return;
    setSaving(true);
    const input = { cwd, base: settings.revision, ...planned.patch };
    let result = await setPolicy({ environmentId, input });
    // Once the runner has it, asking again with the same change waits for its outcome.
    while (result._tag === "Success" && result.value.phase === "following") {
      setFollowing(result.value.operationId);
      result = await setPolicy({ environmentId, input });
    }
    setFollowing(null);
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save the SlipJay policy",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
      return;
    }
    if (result.value.phase === "following") return;
    onOutcome(describePolicyOutcome(result.value));
    // Every outcome rereads the policy: a stale refusal shows the value now in force.
    onSaved();
  };

  const status = saving
    ? describePolicyProgress(
        runner?.serial.find((operation) => operation.operationId === following),
      )
    : "error" in planned
      ? planned.error
      : outcome?.message;
  const statusTone = saving ? undefined : "error" in planned ? "error" : outcome?.tone;

  return (
    <>
      <SettingsRow
        title="Shared policy"
        description={`Committed to ${settings.integrationBranch}, so every machine and agent uses it. Saving lands one change through the runner without running the landing checks.`}
        status={
          status ? (
            <span
              className={cn(
                statusTone === "error" && "text-destructive",
                statusTone === "warning" && "text-warning",
              )}
            >
              {status}
            </span>
          ) : undefined
        }
        control={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={saving || !changed}
                onClick={() => {
                  setDraft(policyDraft(settings));
                  onOutcome(null);
                }}
              >
                Discard
              </Button>
              <Button size="sm" disabled={saving || !changed} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null
        }
      />
      <SettingsRow
        title="Spare workspaces"
        description="Workspaces each machine keeps ready for new work. Each machine can lower its own count below."
        control={
          <NumberField
            value={draft.spares}
            min={0}
            max={SLIPJAY_MAX_SPARES}
            size="sm"
            className="w-auto"
            disabled={!canEdit || saving}
            onValueChange={(value) => {
              if (value !== null) update({ spares: Math.round(value) });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Fewer spare workspaces" />
              <NumberFieldInput aria-label="Spare workspaces" className="w-10 text-center" />
              <NumberFieldIncrement aria-label="More spare workspaces" />
            </NumberFieldGroup>
          </NumberField>
        }
      />
      <SettingsRow
        title="Process level"
        description={PROCESS_DESCRIPTIONS[draft.process]}
        control={
          <Select
            value={draft.process}
            disabled={!canEdit || saving}
            onValueChange={(value) => {
              if (value === "standard" || value === "light") update({ process: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Process level">
              <SelectValue>{(value: SlipJayProcessLevel) => PROCESS_LEVELS[value]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(PROCESS_LEVELS) as SlipJayProcessLevel[]).map((level) => (
                <SelectItem key={level} value={level}>
                  {PROCESS_LEVELS[level]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Landing checks"
        description="The runner runs these before landing a change, one command per line without a shell. Start a line with `cd <dir> &&` to run it in a directory, and end it with ` &` to run it alongside the next."
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            aria-label="Landing checks"
            rows={Math.max(3, draft.checksText.split("\n").length + 1)}
            disabled={!canEdit || saving}
            value={draft.checksText}
            onChange={(event) => update({ checksText: event.target.value })}
          />
        </div>
      </SettingsRow>
      <MachineSparesRow
        environmentId={environmentId}
        cwd={cwd}
        settings={settings}
        machineLabel={machineLabel}
        onSaved={onSaved}
      />
      <SettingsRow
        title="Release branch"
        description={settings.releaseBranch ?? "None: changes deploy from the integration branch."}
      />
      <SettingsRow title="Tracker" description={settings.tracker} />
      {settings.sharedPaths.length > 0 ? (
        <SettingsRow title="Shared paths" description={settings.sharedPaths.join(", ")} />
      ) : null}
      {settings.generatedPaths.length > 0 ? (
        <SettingsRow title="Generated paths" description={settings.generatedPaths.join(", ")} />
      ) : null}
    </>
  );
}

/** This machine's spare limit, which only lowers the shared count and is not committed. */
function MachineSparesRow({
  environmentId,
  cwd,
  settings,
  machineLabel,
  onSaved,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  settings: VcsSlipJayProjectSettings;
  machineLabel: string | null;
  onSaved: () => void;
}) {
  const canEdit = useAtomValue(vcsEnvironment.slipJaySetSpareLimit.permissionAtom(environmentId));
  const setLimit = useAtomCommand(vcsEnvironment.slipJaySetSpareLimit, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const { machineLimit, effective } = settings.machineSpares;

  const save = async (limit: number | null) => {
    setSaving(true);
    const result = await setLimit({ environmentId, input: { cwd, limit } });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change this machine's spares",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
      return;
    }
    onSaved();
  };

  return (
    <SettingsRow
      title={machineLabel === null ? "This machine's spares" : `Spares on ${machineLabel}`}
      description={`Lowers the shared count of ${settings.spares} on ${machineLabel ?? "this machine"} only, so it keeps ${effective} ready.`}
      control={
        <Select
          value={machineLimit === null ? NO_LIMIT : String(machineLimit)}
          disabled={!canEdit || saving}
          onValueChange={(value) => {
            if (typeof value === "string") void save(value === NO_LIMIT ? null : Number(value));
          }}
        >
          <SelectTrigger size="sm" aria-label="This machine's spare limit">
            <SelectValue>
              {(value: string) => (value === NO_LIMIT ? "No limit" : `At most ${value}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={NO_LIMIT}>No limit</SelectItem>
            {Array.from({ length: SLIPJAY_MAX_SPARES + 1 }, (_, count) => (
              <SelectItem key={count} value={String(count)}>
                At most {count}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
