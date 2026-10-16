import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Experiment } from "@t3tools/contracts";
import { useState } from "react";
import {
  describeAssignmentUnit,
  describeExperimentTreatment,
  describeModelSelection,
  describeOrchestrationControls,
} from "@t3tools/client-runtime/experiments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsExperimentsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsScreen title="Experiments">
      <Text className="px-4 text-sm text-foreground-muted">
        See assignments and pause or stop trial enrollment here. Create, start and resume trials and
        compare evidence in web or desktop Settings → Experiments. Pausing preserves existing
        assignments.
      </Text>
      {selectedTargets.length === 0 && (
        <Text className="p-4">Connect an environment to view its trials.</Text>
      )}
      {selectedTargets.map((environment) => (
        <EnvironmentTrials
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsScreen>
  );
}
function EnvironmentTrials({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.experimentsList({ environmentId, input: {} }),
  );
  return (
    <SettingsSection
      title={label}
      trailing={
        <Pressable accessibilityRole="button" onPress={query.refresh}>
          <Text className="p-2 text-sm text-link">Refresh</Text>
        </Pressable>
      }
    >
      {query.error && <Text className="p-4 text-destructive">{query.error}</Text>}
      {query.isPending && !query.data && <Text className="p-4">Loading trials…</Text>}
      {query.data?.length === 0 && (
        <Text className="p-4 text-foreground-muted">No trials in this environment.</Text>
      )}
      {query.data?.map((experiment) => (
        <Trial
          key={experiment.id}
          environmentId={environmentId}
          experiment={experiment}
          refresh={query.refresh}
        />
      ))}
    </SettingsSection>
  );
}
function Trial({
  environmentId,
  experiment,
  refresh,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  refresh: () => void;
}) {
  const canChange = useAtomValue(
    serverEnvironment.experimentsTransition.permissionAtom(environmentId),
  );
  const transition = useAtomCommand(serverEnvironment.experimentsTransition);
  const [pending, setPending] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const assignments = useEnvironmentQuery(
    serverEnvironment.experimentsAssignments({
      environmentId,
      input: { experimentId: experiment.id },
    }),
  );
  const change = async (status: "paused" | "stopped") => {
    if (pending || !canChange) return;
    setPending(true);
    setTransitionError(null);
    const result = await transition({
      environmentId,
      input: { experimentId: experiment.id, status },
    });
    setPending(false);
    if (result._tag === "Success") {
      refresh();
      assignments.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      setTransitionError(String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <View className="gap-2 border-b border-border p-4">
      <Text className="font-t3-medium">{experiment.title}</Text>
      <Text className="text-sm text-foreground-muted">
        {experiment.status} · {experiment.lever} · up to {experiment.maxAssignments} assignments
      </Text>
      <Text className="text-sm">{experiment.question}</Text>
      {experiment.orchestrationControls && (
        <Text className="text-sm text-foreground-muted">
          Held fixed in both arms: {describeOrchestrationControls(experiment.orchestrationControls)}
          .
        </Text>
      )}
      {transitionError && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          Could not {experiment.status === "running" ? "change enrollment" : "stop trial"}:{" "}
          {transitionError}
        </Text>
      )}
      <Pressable accessibilityRole="button" onPress={assignments.refresh}>
        <Text className="text-sm text-link">Refresh assigned units</Text>
      </Pressable>
      {assignments.error && <Text className="text-sm text-destructive">{assignments.error}</Text>}
      {assignments.isPending && !assignments.data && (
        <Text className="text-sm text-foreground-muted">Loading assignments…</Text>
      )}
      {assignments.data?.length === 0 && (
        <Text className="text-sm text-foreground-muted">No units assigned.</Text>
      )}
      {assignments.data?.map((assignment) => {
        const unit = describeAssignmentUnit(assignment);
        return (
          <View key={assignment.id} className="gap-1 rounded-lg border border-border p-3">
            <Text className="font-t3-medium">
              {assignment.assignmentMethod === "observational"
                ? "Historical / observational variant"
                : experiment.status === "running"
                  ? "Assigned variant"
                  : "Retained assigned variant"}
              : {assignment.variant.label}
            </Text>
            <Text className="text-sm">{unit.title}</Text>
            <Text className="text-sm text-foreground-muted">
              {unit.owner} · {assignment.assignmentMethod}
            </Text>
            {assignment.unitKind === "work" && (
              <Text className="text-sm text-foreground-muted">
                Assigned at enrollment, before the parent chose inline or delegated execution.
              </Text>
            )}
            {assignment.assignmentMethod === "observational" && (
              <Text className="text-sm text-foreground-muted">
                Imported evidence; not enrolled or randomized by this trial. Source:{" "}
                {assignment.provenance ?? "unspecified"}
              </Text>
            )}
            <Text className="text-sm">
              {unit.modelLabel}: {describeModelSelection(assignment.assignedModelSelection)}
            </Text>
            {assignment.variant.rollover && (
              <Text className="text-sm">{describeExperimentTreatment(assignment.variant)}</Text>
            )}
            <Text className="text-sm text-foreground-muted">
              Assigned {new Date(assignment.assignedAt).toLocaleString()} · revision{" "}
              {assignment.revision}. Assignment remains pinned when enrollment pauses or stops.
            </Text>
          </View>
        );
      })}
      <View className="flex-row gap-3">
        {experiment.status === "running" && (
          <Pressable
            accessibilityRole="button"
            disabled={!canChange || pending}
            onPress={() => void change("paused")}
          >
            <Text className={!canChange || pending ? "text-foreground-muted" : "text-link"}>
              Pause enrollment
            </Text>
          </Pressable>
        )}
        {experiment.status !== "stopped" && (
          <Pressable
            accessibilityRole="button"
            disabled={!canChange || pending}
            onPress={() => void change("stopped")}
          >
            <Text className={!canChange || pending ? "text-foreground-muted" : "text-link"}>
              Stop trial
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
