import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { type ComposerThreadTarget, composerTargetKey } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import {
  ComposerScreenRecordControl,
  useComposerScreenRecordingAvailable,
} from "./ComposerScreenRecordControl";
import { startScreenRecording, useScreenRecording } from "./screenRecordingSession";

/** The composer's Record control and the send guard while this draft's recording runs. */
export function useComposerScreenRecording({
  enabled,
  target,
  threadTitle,
  fileStagingLimit,
  device,
}: {
  readonly enabled: boolean;
  readonly target: ComposerThreadTarget;
  readonly threadTitle: string | undefined;
  readonly fileStagingLimit: number | null;
  readonly device: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const available = useComposerScreenRecordingAvailable();
  const screenRecording = useScreenRecording();
  const recordingIntoThisDraft =
    screenRecording.origin !== null &&
    composerTargetKey(screenRecording.origin.target) === composerTargetKey(target);
  const start = useStableCallback(() => {
    if (fileStagingLimit === null) return;
    void startScreenRecording(
      {
        target,
        title: threadTitle || gt("New thread"),
        open: () =>
          void (typeof target === "string"
            ? navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(target) })
            : navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(target),
              })),
      },
      fileStagingLimit,
    );
  });
  // The recording attaches only once it stops, so a send now would leave it behind.
  const blocksSend = () => {
    if (!recordingIntoThisDraft) return false;
    toastManager.add({
      type: "info",
      title: gt("Still recording your screen."),
      description: gt("Stop the recording, then send once it's attached."),
    });
    return true;
  };
  const control =
    enabled && available ? (
      <ComposerScreenRecordControl
        busy={screenRecording.state.phase !== "idle"}
        device={device}
        onStart={start}
      />
    ) : null;
  return { control, blocksSend };
}
