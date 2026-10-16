import type { OrchestrationV2ThreadWorkflow } from "@t3tools/contracts";
import {
  THREAD_WORKFLOW_LABELS,
  THREAD_WORKFLOW_TINTS,
  threadWorkflowChipLabel,
  visibleThreadWorkflow,
} from "@t3tools/client-runtime/thread-workflow";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { projectIconColorClassNames } from "../../lib/projectIcon";

/**
 * A thread's workflow as a small pill in its tint, the same tint web uses, with a static
 * moon when it runs unattended.
 */
export function ThreadWorkflowBadge(props: {
  readonly workflow: OrchestrationV2ThreadWorkflow | null | undefined;
}) {
  const shown = visibleThreadWorkflow(props.workflow);
  if (!shown) return null;
  const colors = projectIconColorClassNames(THREAD_WORKFLOW_TINTS[shown.kind]);
  return (
    <View
      accessible
      accessibilityLabel={threadWorkflowChipLabel(shown)}
      className={cn(
        "h-[18px] shrink-0 flex-row items-center gap-0.5 rounded-md px-1.5",
        colors.background,
      )}
    >
      <Text className={cn("text-[11px] font-t3-medium", colors.text)} numberOfLines={1}>
        {THREAD_WORKFLOW_LABELS[shown.kind]}
      </Text>
      {shown.unattended ? (
        <SymbolView
          name="moon"
          size={9}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
    </View>
  );
}
