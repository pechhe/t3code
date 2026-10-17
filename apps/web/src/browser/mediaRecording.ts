// avc3 repeats the H.264 parameter sets in the stream. Chromium's avc1 muxer keeps only the first
// frame's, so a capture that changes size mid-recording (a resized window, or a screen capture whose
// first frame arrives small) becomes undecodable after the change.
const preferredMimeTypes = [
  "video/mp4;codecs=avc3",
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42e01e",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

const estimatedVideoBitsPerSecond = (stream: MediaStream) => {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  return Math.round(
    Math.min(
      50_000_000,
      Math.max(
        2_500_000,
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate ?? 30) * 0.05,
      ),
    ),
  );
};

/** Without a `videoBitsPerSecond`, the bitrate follows the video track's size and frame rate. */
export const createMediaRecorder = (
  stream: MediaStream,
  {
    videoBitsPerSecond = estimatedVideoBitsPerSecond(stream),
  }: { readonly videoBitsPerSecond?: number } = {},
): MediaRecorder => {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond });
};

/** Some recorders only report their container on the chunks they emit. */
export const recordedMimeType = (
  recorder: MediaRecorder,
  chunks: ReadonlyArray<Blob>,
): string | undefined =>
  recorder.mimeType || chunks.find((chunk) => chunk.type.length > 0)?.type || undefined;

export const stopMediaRecorder = async (recorder: MediaRecorder | null): Promise<void> => {
  if (!recorder || recorder.state === "inactive") return;
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), { once: true }),
  );
  recorder.stop();
  await stopped;
};

export const stopMediaStream = (stream: MediaStream | null): void => {
  for (const track of stream?.getTracks() ?? []) track.stop();
};
