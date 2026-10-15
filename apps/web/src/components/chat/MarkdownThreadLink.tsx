import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatThreadLink, percentDecodedThreadLinkId } from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";

import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";

/**
 * A `t3-thread://` link in chat. It shows the thread's current title, so a rename
 * reaches every message that links to it, and leads with the thread's project icon
 * the way a web link leads with its favicon. `label` is what the message wrote,
 * shown only when this client cannot see the thread. Opens the thread in the app.
 *
 * `environmentId` is where the thread lives. A `foreign` link names another environment than the
 * message's own: a client with no saved connection to it cannot open the thread, so it shows the
 * label beside the environment's ID, the only name it has, and copies the link with its
 * qualifier intact.
 */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly foreign?: boolean;
}) {
  const foreign = props.foreign === true;
  const environment = useEnvironment(foreign ? props.environmentId : null);
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const thread = written ?? decoded;
  const threadId = thread?.id ?? props.threadId;
  const project = useProject(
    thread === null ? null : scopeProjectRef(props.environmentId, thread.projectId),
  );
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
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId }}
      // Like an attached thread chip: archived threads are not in the index but still open.
      title={thread === null ? "Thread no longer available" : project?.title}
      data-markdown-copy={formatThreadLink(threadId, title, foreign ? props.environmentId : null)}
    >
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {project === null ? (
          <MessageSquareTextIcon className="block size-full shrink-0" />
        ) : (
          <ProjectFavicon project={project} className="size-full" />
        )}
      </span>
      {title}
    </Link>
  );
}
