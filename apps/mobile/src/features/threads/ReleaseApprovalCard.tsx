import {
  releaseApprovalFacts,
  releaseApprovalFailureMessage,
  releaseApprovalOutcome,
  releaseApprovalTitle,
  shortCommit,
  type ReleaseApprovalItem,
} from "@t3tools/client-runtime/release-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ReleaseApprovalDecision,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

export function ReleaseApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "release_approval_request") return null;
  const outcome = releaseApprovalOutcome(item, visibility);
  if (outcome === null) {
    return <PendingReleaseApproval environmentId={props.environmentId} item={item} />;
  }
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView
        name={item.approvalStatus === "approved" ? "checkmark" : "minus"}
        size={13}
        tintColor={props.iconColor}
        type="monochrome"
      />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {releaseApprovalTitle(item)} · {outcome}
      </Text>
    </View>
  );
}

function PendingReleaseApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ReleaseApprovalItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerReleaseApproval, {
    label: "answer release approval",
    reportFailure: false,
  });
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (decision: ReleaseApprovalDecision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const trimmed = note.trim();
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        approvalId: item.approvalId,
        candidate: item.candidate,
        decision,
        ...(trimmed === "" ? {} : { note: trimmed }),
      },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") return;
    if (!isAtomCommandInterrupted(result)) {
      setError(releaseApprovalFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          Approve release of {item.repository}
        </Text>
        <Text className="font-mono text-xs text-foreground-muted">
          {shortCommit(item.candidate)} onto {shortCommit(item.base)}
        </Text>
      </View>
      <View className="gap-1">
        {releaseApprovalFacts(item.summary).map((fact) => (
          <Text
            key={fact.label}
            className={
              fact.tone === "danger"
                ? "font-sans text-sm text-danger-foreground"
                : fact.tone === "warning"
                  ? "font-sans text-sm text-warning-foreground"
                  : "font-sans text-sm text-foreground-muted"
            }
          >
            {fact.label}
          </Text>
        ))}
        {item.summary.items.map((entry) => (
          <Text key={entry.ref} className="font-sans text-sm text-foreground" numberOfLines={2}>
            {entry.ref} {entry.title}
            {entry.partialBuild ? " · partly built" : ""}
          </Text>
        ))}
        {item.summary.migrations
          .filter((migration) => migration.nonAdditive)
          .map((migration) => (
            <Text key={migration.name} className="font-mono text-xs text-danger-foreground">
              {migration.name} · non-additive
            </Text>
          ))}
      </View>
      {item.details.trim() ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted" numberOfLines={12}>
          {item.details.trim()}
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel="Note for the agent (optional)"
        placeholder="Note for the agent (optional)"
        value={note}
        onChangeText={setNote}
        editable={!submitting}
      />
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label="Approve"
        disabled={submitting}
        onPress={() => void send("approved")}
      />
      <RequestActionButton
        label="Decline"
        tone="secondary"
        disabled={submitting}
        onPress={() => void send("declined")}
      />
    </View>
  );
}
