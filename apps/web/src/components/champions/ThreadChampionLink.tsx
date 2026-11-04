import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Button } from "../ui/button";

export function ThreadChampionLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const champion = thread?.champion;
  if (champion === undefined) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-champion-heading" title="Champion">
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        render={
          <Link to="/champions" search={{ environmentId: props.environmentId, id: champion.id }} />
        }
      >
        <ShieldCheckIcon />
        {champion.attention ? "Open champion, needs attention" : "Open champion"}
      </Button>
    </ThreadDetailsSection>
  );
}
