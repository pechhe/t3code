import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ respond: vi.fn() }));

vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => commands.respond) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

import { act, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const environmentId = EnvironmentId.make("delegated-environment");
const parentId = ThreadId.make("parent");
const leadId = ThreadId.make("lead");
const requestId = RuntimeRequestId.make("lead-approval");

const leadApproval: PendingThreadRequests = {
  approvals: [
    {
      requestId,
      requestKind: "command",
      createdAt: "2026-11-04T12:00:00.000Z",
      responseCapability: "live",
    },
  ],
  userInputs: [],
};

function setup() {
  commands.respond.mockReset();
  commands.respond.mockResolvedValue({ _tag: "Success", value: undefined });
  const seen: { current: ReturnType<typeof usePendingThreadRequests> | null } = { current: null };
  function Probe(props: { readonly delegated: PendingThreadRequests | null }) {
    const promptRef = useRef("");
    const composerRef = useRef(null);
    const fixture = makeThreadProjectionFixture();
    const projection = { ...fixture, thread: { ...fixture.thread, id: parentId } };
    const state = usePendingThreadRequests({
      environmentId,
      activeThreadId: parentId,
      serverProjection: projection,
      delegatedRequests:
        props.delegated === null ? null : { threadId: leadId, requests: props.delegated },
      supportsQuestionAttachments: false,
      composerDraftTarget: { environmentId, threadId: parentId },
      setComposerDraftPrompt: () => {},
      promptRef,
      composerRef,
      setThreadError: () => {},
    });
    useLayoutEffect(() => {
      seen.current = state;
    });
    return null;
  }
  return { Probe, seen };
}

it("answers a subagent's approval on the subagent's thread, not the parent's", async () => {
  const { Probe, seen } = setup();
  await using _screen = await render(<Probe delegated={leadApproval} />, { router: false });
  expect(seen.current?.delegatedRequestThreadId).toBe(leadId);
  expect(seen.current?.activePendingApproval?.requestId).toBe(requestId);

  await act(async () => {
    await seen.current?.onRespondToApproval(requestId, "decline");
  });

  expect(commands.respond).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId: leadId, requestId, decision: "decline" }),
    }),
  );
});

it("has nothing delegated to answer while no subagent asks", async () => {
  const { Probe, seen } = setup();
  await using _screen = await render(<Probe delegated={null} />, { router: false });
  expect(seen.current?.delegatedRequestThreadId).toBeNull();
  expect(seen.current?.activePendingApproval).toBeNull();
});
