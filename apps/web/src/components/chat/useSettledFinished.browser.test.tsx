import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useSettledFinished } from "./useSettledFinished";

const HOLD_MS = 20;
const reviewer = ThreadId.make("reviewer");
const advisor = ThreadId.make("advisor");
const refFor = (threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("settled-environment"),
  threadId: ThreadId.make(threadId),
});

function setup() {
  const seen: { current: ReadonlySet<ThreadId> | null } = { current: null };
  function Probe(props: {
    readonly threadRef: ScopedThreadRef;
    readonly finished: ReadonlyArray<ThreadId>;
    readonly holdMs?: number;
    readonly visible?: boolean;
  }) {
    const settled = useSettledFinished(
      props.threadRef,
      props.finished,
      props.visible ?? true,
      props.holdMs ?? HOLD_MS,
    );
    useLayoutEffect(() => {
      seen.current = settled;
    });
    return null;
  }
  return { Probe, seen };
}

it("keeps a finished subagent recent until its time in view has passed", async () => {
  const { Probe, seen } = setup();
  await using _screen = await render(
    <Probe threadRef={refFor("in-view")} finished={[reviewer]} />,
    {
      router: false,
    },
  );
  expect(seen.current?.has(reviewer)).toBe(false);
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
});

it("starts again on return when it left before its time was up", async () => {
  const { Probe, seen } = setup();
  const threadRef = refFor("left-early");
  const away = await render(<Probe threadRef={threadRef} finished={[reviewer]} holdMs={60_000} />, {
    router: false,
  });
  await away.unmount();
  await using _screen = await render(<Probe threadRef={threadRef} finished={[reviewer]} />, {
    router: false,
  });
  expect(seen.current?.has(reviewer)).toBe(false);
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
});

it("remembers what already moved when the thread is opened again", async () => {
  const { Probe, seen } = setup();
  const threadRef = refFor("moved");
  const first = await render(<Probe threadRef={threadRef} finished={[reviewer]} />, {
    router: false,
  });
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
  await first.unmount();
  seen.current = null;
  await using _screen = await render(<Probe threadRef={threadRef} finished={[reviewer]} />, {
    router: false,
  });
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
});

it("keeps each thread's subagents apart", async () => {
  const { Probe, seen } = setup();
  await using screen = await render(<Probe threadRef={refFor("first")} finished={[reviewer]} />, {
    router: false,
  });
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
  await screen.rerender(
    <Probe threadRef={refFor("second")} finished={[reviewer]} holdMs={60_000} />,
  );
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(false));
});

it("gives each subagent its own time, so a later finish does not hold an earlier one back", async () => {
  const { Probe, seen } = setup();
  const threadRef = refFor("own-time");
  const start = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await using screen = await render(
    <Probe threadRef={threadRef} finished={[reviewer]} holdMs={60_000} />,
    { router: false },
  );
  clock.mockReturnValue(start + 59_990);
  await screen.rerender(
    <Probe threadRef={threadRef} finished={[reviewer, advisor]} holdMs={60_000} />,
  );
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
  expect(seen.current?.has(advisor)).toBe(false);
  clock.mockRestore();
});

it("does not spend a subagent's time while it is out of view", async () => {
  const { Probe, seen } = setup();
  const threadRef = refFor("out-of-view");
  const start = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  await using screen = await render(
    <Probe threadRef={threadRef} finished={[reviewer]} holdMs={60_000} visible={false} />,
    { router: false },
  );
  clock.mockReturnValue(start + 120_000);
  await screen.rerender(<Probe threadRef={threadRef} finished={[reviewer]} holdMs={60_000} />);
  expect(seen.current?.has(reviewer)).toBe(false);
  clock.mockReturnValue(start + 179_990);
  await screen.rerender(<Probe threadRef={threadRef} finished={[reviewer]} holdMs={60_001} />);
  await vi.waitFor(() => expect(seen.current?.has(reviewer)).toBe(true));
  clock.mockRestore();
});
