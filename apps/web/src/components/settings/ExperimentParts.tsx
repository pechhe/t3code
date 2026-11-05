import { useAtomValue } from "@effect/atom-react";
import {
  describeTrialFailure,
  isRolloverTrial,
  VARIANT_LETTERS,
  variantNameBesideLetter,
  type TrialAction,
  type TrialContext,
  type TrialIssue,
} from "@t3tools/client-runtime/experiments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentPolicyManifest,
  EnvironmentId,
  Experiment,
  ExperimentStatus,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { catalogModels, unavailableReason } from "./DelegationSettings.logic";
import { useAgentPolicies } from "./useAgentPolicies";
import { useInstanceEntries } from "./useInstanceEntries";

/** One environment's setup, as a trial draft is judged against it. */
export function useTrialEnvironment(environmentId: EnvironmentId) {
  const { settings, providers, entries } = useInstanceEntries(environmentId);
  const { policies, reload } = useAgentPolicies([environmentId]);
  const allProjects = useProjects();
  const [now] = useState(() => new Date());
  const policy = policies[0];
  const manifest: AgentPolicyManifest | null = policy?.data?.snapshot.manifest ?? null;
  const catalog = catalogModels(providers);
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const driverOf = (instanceId: ProviderInstanceId) =>
    entries.find((entry) => entry.instanceId === instanceId)?.driverKind;
  const nameOfSlug = (driverKind: ProviderDriverKind | undefined, model: string) =>
    catalog.find(
      (candidate) =>
        candidate.binding.driverKind === driverKind && candidate.binding.model === model,
    )?.label ?? model;
  const modelName = (selection: ModelSelection) =>
    nameOfSlug(driverOf(selection.instanceId), selection.model);
  const unavailable = (selection: ModelSelection) => {
    if (providers.length === 0) return null;
    const driverKind = driverOf(selection.instanceId);
    return driverKind === undefined
      ? "not installed"
      : unavailableReason({ driverKind, model: selection.model }, providers);
  };
  const instanceFor = (driverKind: ProviderDriverKind) =>
    (
      entries.find((entry) => entry.driverKind === driverKind && entry.isDefault) ??
      entries.find((entry) => entry.driverKind === driverKind)
    )?.instanceId ?? null;
  const projectName = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "another project";
  const contextFor = (otherTrials: ReadonlyArray<Experiment>): TrialContext => ({
    now,
    manifest,
    modelName,
    unavailable,
    projectName,
    otherTrials,
  });
  return {
    settings,
    providers,
    entries,
    catalog,
    manifest,
    policyPending: policy?.isPending ?? false,
    reloadPolicy: reload,
    now,
    projects,
    modelName,
    nameOfSlug,
    instanceFor,
    projectName,
    contextFor,
  };
}

export type TrialEnvironment = ReturnType<typeof useTrialEnvironment>;

export function TrialRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-t border-border/60 p-3 first:border-t-0 sm:px-4",
        className,
      )}
      {...props}
    />
  );
}

export function VariantLetter({ children }: { children: ReactNode }) {
  return <span className="mr-0.5 font-semibold">{children}</span>;
}

/** A variant's letter and name; an old label's own copy of the letter isn't shown twice. */
export function VariantName({ label, index }: { label: string; index: number }) {
  return (
    <>
      <VariantLetter>{VARIANT_LETTERS[index] ?? "?"}</VariantLetter>{" "}
      {variantNameBesideLetter(label, index)}
    </>
  );
}

export function TrialNote({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function IssueLine({
  issue,
  onOpenTrial,
}: {
  issue: TrialIssue;
  onOpenTrial?: (trialId: string) => void;
}) {
  const rivalId = issue.rivalId;
  return (
    <p className="text-xs text-warning-foreground" role="alert">
      {issue.text}
      {rivalId !== undefined && onOpenTrial ? (
        <>
          {" "}
          <InlineButton onClick={() => onOpenTrial(rivalId)}>Open it</InlineButton>
        </>
      ) : null}
    </p>
  );
}

export interface TrialFailure {
  readonly message: string;
  readonly retry: () => void;
}

export function TrialErrorBox({
  failure,
  onDismiss,
}: {
  failure: TrialFailure | null;
  onDismiss: () => void;
}) {
  if (failure === null) return null;
  return (
    <Alert variant="error" size="sm">
      <AlertDescription>{failure.message}</AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost-muted" onClick={failure.retry}>
          Try again
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** What a settled command means for the page: null on success or when it was interrupted. */
export function commandFailure<A, E>(
  action: TrialAction,
  result: AtomCommandResult<A, E>,
): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  return describeTrialFailure(action, squashAtomCommandFailure(result));
}

const STATUS_DONE: Readonly<Record<"start" | "resume" | "pause" | "stop" | "delete", string>> = {
  start: "Trial started.",
  resume: "Trial resumed.",
  pause: "Trial paused. Work already assigned keeps its variant.",
  stop: "Trial stopped.",
  delete: "Draft deleted.",
};

export function announce(title: string) {
  toastManager.add(stackedThreadToast({ type: "success", title }));
}

/** Start, pause, resume, stop and delete, with the confirm and the error they can leave behind. */
export function useTrialActions(
  environmentId: EnvironmentId,
  experiment: Experiment,
  onChanged: () => void,
) {
  const transition = useAtomCommand(serverEnvironment.experimentsTransition);
  const canChange = useAtomValue(
    serverEnvironment.experimentsTransition.permissionAtom(environmentId),
  );
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const [failure, setFailure] = useState<TrialFailure | null>(null);
  const change = async (action: keyof typeof STATUS_DONE, status: ExperimentStatus) => {
    setPending(true);
    setConfirm(null);
    setFailure(null);
    const result = await transition({
      environmentId,
      input: { experimentId: experiment.id, status },
    });
    setPending(false);
    const message = commandFailure(action, result);
    if (message !== null) {
      setFailure({ message, retry: () => void change(action, status) });
      return;
    }
    if (result._tag !== "Success") return;
    announce(STATUS_DONE[action]);
    onChanged();
  };
  return {
    canChange,
    pending,
    confirm,
    setConfirm,
    change,
    failure,
    dismissFailure: () => setFailure(null),
  };
}

export type TrialActions = ReturnType<typeof useTrialActions>;

export function TrialActionButtons({
  experiment,
  actions,
  blocked,
  onResults,
  onEdit,
}: {
  experiment: Experiment;
  actions: TrialActions;
  blocked: boolean;
  onResults?: () => void;
  onEdit?: () => void;
}) {
  const { canChange, pending, confirm, setConfirm, change } = actions;
  if (confirm !== null) {
    const deleting = confirm === "delete";
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          {deleting
            ? "Delete this draft?"
            : "Stop this trial? Nothing new enrols, and work already assigned keeps its variant."}
        </span>
        <Button
          size="xs"
          disabled={pending}
          onClick={() => void change(deleting ? "delete" : "stop", "stopped")}
        >
          {deleting ? "Delete draft" : "Stop trial"}
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => setConfirm(null)}>
          {deleting ? "Keep" : "Keep running"}
        </Button>
      </div>
    );
  }
  if (isRolloverTrial(experiment)) return null;
  const results = onResults ? (
    <Button size="xs" variant="ghost-muted" onClick={onResults}>
      Results
    </Button>
  ) : null;
  const stop = (
    <Button
      size="xs"
      variant="outline"
      disabled={!canChange || pending}
      onClick={() => setConfirm("stop")}
    >
      Stop
    </Button>
  );
  let buttons: ReactNode = results;
  if (experiment.status === "draft") {
    buttons = (
      <>
        <Button
          size="xs"
          disabled={!canChange || pending || blocked}
          onClick={() => void change("start", "running")}
        >
          Start
        </Button>
        {onEdit ? (
          <Button size="xs" variant="outline" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canChange || pending}
          onClick={() => setConfirm("delete")}
        >
          Delete
        </Button>
      </>
    );
  } else if (experiment.status === "running") {
    buttons = (
      <>
        {results}
        <Button
          size="xs"
          variant="outline"
          disabled={!canChange || pending}
          onClick={() => void change("pause", "paused")}
        >
          Pause
        </Button>
        {stop}
      </>
    );
  } else if (experiment.status === "paused") {
    buttons = (
      <>
        {results}
        <Button
          size="xs"
          disabled={!canChange || pending}
          onClick={() => void change("resume", "running")}
        >
          Resume
        </Button>
        {stop}
      </>
    );
  }
  return buttons === null ? null : (
    <div className="flex flex-wrap items-center gap-1">{buttons}</div>
  );
}
