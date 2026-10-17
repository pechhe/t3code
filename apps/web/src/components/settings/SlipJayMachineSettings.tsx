import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isLocalSlipJayRunner,
  SlipJayRunnerLocation,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { slipJayPauseTitle, useSlipJayRunnerPause } from "../SlipJayRunnerControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { LOCAL_RUNNER_LOCATION } from "./SlipJaySettings.logic";

const isRunnerLocation = Schema.is(SlipJayRunnerLocation);

/**
 * The SlipJay runner this environment's machine lands through, from its SlipJay machine
 * config. Hidden where SlipJay is not installed.
 */
export function SlipJayMachineSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    vcsEnvironment.slipJayMachineSettings({ environmentId, input: {} }),
  );
  const machine = query.data;
  if (!machine?.available) return null;
  return (
    <SettingsSection {...searchableSetting("slipjay-runner")} title="SlipJay runner">
      <RunnerLocationRow
        // A saved location starts the draft again from the one in force.
        key={machine.runnerInFile ?? ""}
        environmentId={environmentId}
        runner={machine.runner}
        runnerInFile={machine.runnerInFile}
        overriddenByEnvironment={machine.overriddenByEnvironment}
        onSaved={query.refresh}
      />
      {machine.runner !== null ? (
        <RunnerQueueRow
          environmentId={environmentId}
          local={isLocalSlipJayRunner(machine.runner)}
        />
      ) : null}
    </SettingsSection>
  );
}

type RunnerChoice = "remote" | "local";

function RunnerLocationRow({
  environmentId,
  runner,
  runnerInFile,
  overriddenByEnvironment,
  onSaved,
}: {
  environmentId: EnvironmentId;
  runner: string | null;
  runnerInFile: string | null;
  overriddenByEnvironment: boolean;
  onSaved: () => void;
}) {
  const canEdit = useAtomValue(vcsEnvironment.slipJaySetRunner.permissionAtom(environmentId));
  const setRunner = useAtomCommand(vcsEnvironment.slipJaySetRunner, { reportFailure: false });
  const [choice, setChoice] = useState<RunnerChoice>(
    isLocalSlipJayRunner(runnerInFile) ? "local" : "remote",
  );
  const [remoteDraft, setRemoteDraft] = useState(
    isLocalSlipJayRunner(runnerInFile) ? "" : (runnerInFile ?? ""),
  );
  const [saving, setSaving] = useState(false);
  // A runner already set on another local port keeps it; otherwise SlipJay's default port.
  const localLocation =
    runnerInFile !== null && isLocalSlipJayRunner(runnerInFile)
      ? runnerInFile
      : LOCAL_RUNNER_LOCATION;
  const location = choice === "local" ? localLocation : remoteDraft.trim();
  const valid = location === "" || isRunnerLocation(location);
  const changed = location !== (runnerInFile ?? "");

  const save = async () => {
    setSaving(true);
    const result = await setRunner({
      environmentId,
      input: { location: location === "" ? null : location },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change the runner",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
      return;
    }
    onSaved();
  };

  return (
    <SettingsRow
      title="Runner location"
      description="Where this machine lands work: a runner on another machine over SSH, or one on this machine. Other machines keep their own."
      status={
        !valid ? (
          <span className="text-destructive">Use ssh://&lt;host&gt;.</span>
        ) : overriddenByEnvironment ? (
          `SLIPJAY_RUNNER in the server's environment overrides this: it lands through ${runner}.`
        ) : runner === null ? (
          "No runner set, so this machine cannot land work."
        ) : undefined
      }
    >
      <div className="mt-3 flex max-w-2xl flex-wrap items-center gap-2 pb-3.5">
        <ToggleGroup
          aria-label="Runner location"
          value={[choice]}
          disabled={!canEdit || saving}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "remote" || value === "local") setChoice(value);
          }}
        >
          <Toggle value="remote">Remote runner</Toggle>
          <Toggle value="local">This machine</Toggle>
        </ToggleGroup>
        {choice === "remote" ? (
          <Input
            aria-label="Remote runner"
            className="min-w-48 flex-1"
            size="sm"
            placeholder="ssh://runner-host"
            disabled={!canEdit || saving}
            value={remoteDraft}
            onChange={(event) => setRemoteDraft(event.target.value)}
          />
        ) : null}
        {canEdit ? (
          <Button size="sm" disabled={saving || !changed || !valid} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
    </SettingsRow>
  );
}

/** Whether the runner's watch is connected, and its queue's pause, which holds every machine. */
function RunnerQueueRow({
  environmentId,
  local,
}: {
  environmentId: EnvironmentId;
  local: boolean;
}) {
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const { canControl, busy, control } = useSlipJayRunnerPause(environmentId);
  const connected = overview?.connected === true;
  const paused = overview?.paused === true;
  return (
    <SettingsRow
      title="Queue"
      description={
        paused
          ? "Paused: queued operations from every machine wait until it resumes."
          : connected
            ? "Running: the runner takes queued operations in turn, from every machine."
            : local
              ? "No runner is answering on this machine. Start one here with `bws run -- slipjay runner serve`, or switch to the remote runner."
              : "Connecting to the runner…"
      }
      control={
        overview && canControl ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title={slipJayPauseTitle(paused)}
            onClick={() => void control(paused ? "resume" : "pause")}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        ) : null
      }
    />
  );
}
