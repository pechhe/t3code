import { championCadenceMs, formatChampionDuration } from "@t3tools/client-runtime/champions";
import type { ChampionDetail, EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  emptyMetricDraft,
  metricChange,
  metricDraftOf,
  type MetricDraft,
  metricInputsOf,
  metricsMatchProposal,
  parseMetricDrafts,
} from "./champions.logic";
import { ChampionMachineNotice } from "./ChampionMachineNotice";
import { useChampionAction, useChampionCommandAllowed } from "./useChampionAction";

const DIRECTION_LABELS: Record<MetricDraft["direction"], string> = {
  lower: "Lower is better",
  higher: "Higher is better",
  range: "Stay inside a range",
  observe: "Just observe",
};

function MetricDraftEditor(props: {
  readonly draft: MetricDraft;
  readonly error: string | undefined;
  readonly change: string | null;
  readonly staleDefault: string;
  readonly onChange: (patch: Partial<MetricDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { draft } = props;
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Metric name"
          placeholder="Metric name"
          value={draft.name}
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
        <Label className="shrink-0">
          <Checkbox
            checked={draft.required}
            onCheckedChange={(required) => props.onChange({ required: required === true })}
          />
          Required
        </Label>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Stop tracking ${draft.name || "this metric"}`}
          onClick={props.onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[90px_minmax(0,1fr)_90px_90px]">
        <Input
          aria-label="Unit"
          placeholder="Unit"
          value={draft.unit}
          onChange={(event) => props.onChange({ unit: event.target.value })}
        />
        <Select
          value={draft.direction}
          onValueChange={(direction) => direction && props.onChange({ direction })}
        >
          <SelectTrigger aria-label="Direction">
            <SelectValue>{DIRECTION_LABELS[draft.direction]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(DIRECTION_LABELS) as Array<MetricDraft["direction"]>).map((direction) => (
              <SelectItem key={direction} value={direction}>
                {DIRECTION_LABELS[direction]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {draft.direction === "observe" ? null : (
          <>
            <Input
              aria-label="Lowest acceptable value"
              placeholder="Min"
              inputMode="decimal"
              value={draft.minimum}
              onChange={(event) => props.onChange({ minimum: event.target.value })}
            />
            <Input
              aria-label="Highest acceptable value"
              placeholder="Max"
              inputMode="decimal"
              value={draft.maximum}
              onChange={(event) => props.onChange({ maximum: event.target.value })}
            />
          </>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Baseline"
          placeholder="Baseline, optional"
          inputMode="decimal"
          value={draft.baseline}
          onChange={(event) => props.onChange({ baseline: event.target.value })}
        />
        <Input
          aria-label="Out of date after, in hours"
          placeholder={`Out of date after, hours (${props.staleDefault})`}
          inputMode="decimal"
          value={draft.staleAfterHours}
          onChange={(event) => props.onChange({ staleAfterHours: event.target.value })}
        />
      </div>
      <Input
        aria-label="Source"
        placeholder="Where does the reading come from?"
        value={draft.source}
        onChange={(event) => props.onChange({ source: event.target.value })}
      />
      <Input
        aria-label="Why it matters"
        placeholder="Why does it matter?"
        value={draft.description}
        onChange={(event) => props.onChange({ description: event.target.value })}
      />
      <Input
        aria-label="How it is measured"
        placeholder="How exactly is it measured?"
        value={draft.context}
        onChange={(event) => props.onChange({ context: event.target.value })}
      />
      {props.change ? <p className="text-muted-foreground text-xs">{props.change}</p> : null}
      {props.error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function ChampionMetricsEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: ChampionDetail;
  readonly onDone: () => void;
}) {
  const { environmentId, detail } = props;
  const { champion, metrics, proposal } = detail;
  const [drafts, setDrafts] = useState<ReadonlyArray<MetricDraft>>(() =>
    (proposal?.metrics ?? metricInputsOf(metrics)).map(metricDraftOf),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const { busy, error, run } = useChampionAction();
  const propose = useAtomCommand(serverEnvironment.proposeChampionMetrics, {
    label: "champion propose metrics",
    reportFailure: false,
  });
  const accept = useAtomCommand(serverEnvironment.acceptChampionMetrics, {
    label: "champion accept metrics",
    reportFailure: false,
  });
  const setLifecycle = useAtomCommand(serverEnvironment.setChampionLifecycle, {
    label: "champion lifecycle",
    reportFailure: false,
  });
  const canPropose = useChampionCommandAllowed(
    serverEnvironment.proposeChampionMetrics,
    environmentId,
  );
  const canAccept = useChampionCommandAllowed(
    serverEnvironment.acceptChampionMetrics,
    environmentId,
  );
  const canSetLifecycle = useChampionCommandAllowed(
    serverEnvironment.setChampionLifecycle,
    environmentId,
  );
  const initial = metrics.length === 0;
  const parsed = parseMetricDrafts(drafts);

  const changeNote = (draft: MetricDraft) => {
    if (!parsed.ok || initial) return null;
    const metric = parsed.metrics.find(
      (candidate) => candidate.id === draft.id || candidate.name === draft.name.trim(),
    );
    if (metric === undefined) return null;
    const change = metricChange(metric, metrics);
    if (change === "new") return "New metric. It reads as not yet measured until its first check.";
    if (change === "new-series") {
      return "This measures something different, so a new series starts. Earlier readings stay as history and aren't joined to it.";
    }
    return null;
  };

  const removed = metrics.filter((metric) => !drafts.some((draft) => draft.id === metric.id));

  const save = async (start: boolean) => {
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    const id = champion.id;
    const unchanged = metricsMatchProposal(parsed.metrics, proposal);
    const reason = proposal ? `${proposal.reason} Edited by you.` : "Edited by you.";
    // Accept exactly the proposal shown, or the one this save just filed.
    let proposalId = unchanged ? proposal?.id : undefined;
    const ok = await run("save", "metrics", [
      ...(unchanged
        ? []
        : [
            () =>
              propose({
                environmentId,
                input: { id, metrics: parsed.metrics, reason },
              }).then((result) => {
                if (result._tag === "Success") proposalId = result.value.proposal?.id;
                return result;
              }),
          ]),
      () =>
        accept({
          environmentId,
          input: { id, ...(proposalId === undefined ? {} : { proposalId }) },
        }),
      ...(start
        ? [() => setLifecycle({ environmentId, input: { id, lifecycle: "active" as const } })]
        : []),
    ]);
    if (ok) props.onDone();
  };

  const disabled = busy !== null || !canPropose || !canAccept;
  return (
    <div className="mx-auto flex max-w-180 flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg">Metrics for {champion.name}</h2>
        <p className="text-muted-foreground text-xs">
          {initial
            ? "Nothing runs until you accept. Edit anything."
            : "Changing a unit, source, measurement or direction starts a new series. Old readings stay as history and aren't joined to it."}
        </p>
      </div>
      <ChampionMachineNotice environmentId={environmentId} draft />
      <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
        {drafts.map((draft) => (
          <MetricDraftEditor
            key={draft.key}
            draft={draft}
            error={errors[draft.key]}
            change={changeNote(draft)}
            staleDefault={formatChampionDuration(championCadenceMs(champion.schedule) * 2)}
            onChange={(patch) =>
              setDrafts((current) =>
                current.map((candidate) =>
                  candidate.key === draft.key ? { ...candidate, ...patch } : candidate,
                ),
              )
            }
            onRemove={() =>
              setDrafts((current) => current.filter((candidate) => candidate.key !== draft.key))
            }
          />
        ))}
        {drafts.length === 0 ? (
          <p className="p-3 text-muted-foreground text-sm">No metrics yet.</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setDrafts((current) => [...current, emptyMetricDraft(randomUUID())])}
        >
          <PlusIcon />
          Add a metric
        </Button>
        {removed.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Stops tracking {removed.map((metric) => metric.name).join(", ")}. Their readings stay as
            history.
          </p>
        ) : null}
        {errors[""] ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {errors[""]}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy !== null} onClick={props.onDone}>
          Cancel
        </Button>
        {initial ? (
          <>
            <Button variant="outline" disabled={disabled} onClick={() => void save(false)}>
              Accept, stay paused
            </Button>
            <Button disabled={disabled || !canSetLifecycle} onClick={() => void save(true)}>
              Accept and start
            </Button>
          </>
        ) : (
          <Button disabled={disabled} onClick={() => void save(false)}>
            Accept changes
          </Button>
        )}
      </div>
    </div>
  );
}
