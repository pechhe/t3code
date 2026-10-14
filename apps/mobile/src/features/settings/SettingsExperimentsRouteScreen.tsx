import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Experiment } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
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
        Manage trial enrollment here. Create trials and compare evidence in web or desktop Settings
        → Experiments. Pausing preserves existing assignments.
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
  const change = async (status: "paused" | "stopped") => {
    if (pending || !canChange) return;
    setPending(true);
    const result = await transition({
      environmentId,
      input: { experimentId: experiment.id, status },
    });
    setPending(false);
    if (result._tag === "Success") refresh();
  };
  return (
    <View className="gap-2 border-b border-border p-4">
      <Text className="font-t3-medium">{experiment.title}</Text>
      <Text className="text-sm text-foreground-muted">
        {experiment.status} · {experiment.lever} · up to {experiment.maxAssignments} assignments
      </Text>
      <Text className="text-sm">{experiment.question}</Text>
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
