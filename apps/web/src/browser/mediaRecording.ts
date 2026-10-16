const preferredMimeTypes = [
  "video/mp4;codecs=avc1",
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.42e01e",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

export const createMediaRecorder = (
  stream: MediaStream,
  { maxVideoBitsPerSecond = 50_000_000 }: { readonly maxVideoBitsPerSecond?: number } = {},
): MediaRecorder => {
  const mimeType = preferredMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const videoBitsPerSecond = Math.round(
    Math.min(
      maxVideoBitsPerSecond,
      Math.max(
        2_500_000,
        (settings?.width ?? 1920) * (settings?.height ?? 1080) * (settings?.frameRate ?? 30) * 0.05,
      ),
    ),
  );
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
