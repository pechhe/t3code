import { groupOpenReleaseApprovals } from "@t3tools/client-runtime/release-approval";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { ReleaseApprovalCard } from "./chat/ReleaseApprovalCard";
import { InlineButton } from "./ui/button";

/**
 * Open release approvals sit above every thread section, one card per repository, so the
 * owner sees one thing to approve rather than a request buried in a long thread.
 */
export function SidebarReleaseApprovals(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const approvals = groupOpenReleaseApprovals(props.threads);
  if (approvals.length === 0) return null;
  return (
    <section aria-label="Release approvals" className="flex flex-col gap-2 px-2 pb-3">
      {approvals.map((approval) => (
        <ReleaseApprovalCard
          key={approval.key}
          environmentId={approval.threads[0]!.environmentId}
          card={approval.card}
          context={
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              Asked by
              {approval.threads.map((thread, index) => (
                <span key={thread.id} className="inline-flex min-w-0 items-center">
                  <InlineButton
                    tone="muted"
                    onClick={() =>
                      props.onOpenThread(scopeThreadRef(thread.environmentId, thread.id))
                    }
                  >
                    {thread.title}
                  </InlineButton>
                  {index < approval.threads.length - 1 ? "," : null}
                </span>
              ))}
            </p>
          }
        />
      ))}
    </section>
  );
}
