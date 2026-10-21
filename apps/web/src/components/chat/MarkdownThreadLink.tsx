import { useEnvironment } from "../../state/environments";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatThreadLink,
  percentDecodedThreadLinkId,
  resolveThreadLinkRef,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { ThreadContextChip } from "../ThreadContextChip";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly foreign?: boolean;
  readonly qualified?: boolean;
}) {
  const foreign = props.foreign === true;
  const qualified = foreign || props.qualified === true;
  const environment = useEnvironment(foreign ? props.environmentId : null);
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const refs = useThreadRefs(local === null && !qualified);
  const remote = useThreadShell(
    local === null && !qualified
      ? resolveThreadLinkRef(scopeThreadRef(props.environmentId, props.threadId), refs)
      : null,
  );
  const thread = local ?? remote;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? props.threadId;
  const title = thread?.title.trim() || props.label;
  // An archived thread is missing from the shell index yet opens; only an environment this client
  // does not know leaves nothing to open.
  if (foreign && environment === null) {
    return (
      <span data-markdown-copy={formatThreadLink(threadId, title, props.environmentId)}>
        {title} <span className="text-muted-foreground">(environment {props.environmentId})</span>
      </span>
    );
  }
  return (
    <ThreadContextChip
      record={{ environmentId, threadId, title: props.label }}
      copyMarkdown={formatThreadLink(
        threadId,
        title,
        qualified || environmentId !== props.environmentId ? environmentId : null,
      )}
    />
  );
}
