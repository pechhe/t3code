import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useEnvironmentQuery } from "../../state/query";
import { threadHandoffEnvironment } from "../../state/threadHandoff";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";

type HandoffTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/**
 * "Continue on…": the linked environments this thread can move to. Picking
 * one starts the move and closes the sheet; the thread's card shows how it goes.
 */
export function ThreadHandoffSheet({ route }: StaticScreenProps<HandoffTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const options = useEnvironmentQuery(
    threadHandoffEnvironment.options({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    }),
  );
  const start = useAtomCommand(threadHandoffEnvironment.start, {
    label: "move thread",
    reportFailure: false,
  });
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A message waiting in the outbox exists only on this device. Once the thread
  // starts moving, the server refuses it, so it would be lost.
  const outboxWaiting = useQueuedThreadKeys().has(
    scopedThreadKey(target.environmentId, target.threadId),
  );

  const choose = async (environmentId: EnvironmentId, projectId?: ProjectId) => {
    if (outboxWaiting) return;
    void Haptics.selectionAsync();
    setStarting(projectId === undefined ? environmentId : `${environmentId}|${projectId}`);
    setError(null);
    const result = await start({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        environmentId,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    setStarting(null);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    navigation.goBack();
  };

  const targets = options.data?.options ?? [];
  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      <Text className="pb-2 pt-3 text-sm text-foreground-muted">
        Moves the conversation, unpushed commits, and uncommitted changes. This thread becomes
        read-only here.
      </Text>
      {outboxWaiting ? (
        <Text accessibilityRole="alert" className="pt-2 text-sm text-danger-foreground">
          A message is still waiting to send from this device. Send or discard it first.
        </Text>
      ) : null}
      {options.error ? (
        <Text className="pt-4 text-sm text-danger-foreground">{options.error}</Text>
      ) : options.data === null ? (
        <Text className="pt-4 text-sm text-foreground-muted">Asking linked environments…</Text>
      ) : targets.length === 0 ? (
        <Text className="pt-4 text-sm text-foreground-muted">
          No linked environments. Link one from a desktop or with `t3 environment link`.
        </Text>
      ) : (
        targets.flatMap((option) =>
          // Several projects there fit; each is its own choice.
          (option.candidates !== undefined && option.candidates.length > 0
            ? option.candidates.map((candidate) => ({
                key: `${option.environmentId}|${candidate.projectId}`,
                label: `${option.label} · ${candidate.title}`,
                environmentId: option.environmentId,
                projectId: candidate.projectId,
                reason: option.reason,
              }))
            : [
                {
                  key: option.environmentId,
                  label: option.label,
                  environmentId: option.environmentId,
                  projectId: undefined,
                  reason: option.reason,
                },
              ]
          ).map((choice) => (
            <Pressable
              key={choice.key}
              accessibilityRole="button"
              accessibilityState={{
                disabled: choice.reason !== null || starting !== null || outboxWaiting,
              }}
              disabled={choice.reason !== null || starting !== null || outboxWaiting}
              onPress={() => void choose(choice.environmentId, choice.projectId)}
              className="border-b border-border py-3.5 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-base font-t3-bold text-foreground">
                {starting === choice.key ? `Moving to ${choice.label}…` : choice.label}
              </Text>
              {choice.reason !== null ? (
                <Text className="text-xs text-foreground-muted">{choice.reason}</Text>
              ) : null}
            </Pressable>
          )),
        )
      )}
      {error !== null ? (
        <Text accessibilityRole="alert" className="pt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Continue on…" onClose={() => navigation.goBack()} />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
