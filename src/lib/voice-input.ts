export const MAX_VOICE_RECORDING_SECONDS = 10 * 60;
export const VOICE_WAVEFORM_BARS = 28;
export const VOICE_TRANSCRIPTION_POLL_INTERVAL_MS = 750;

export function normalizeVoiceMimeType(mimeType: string) {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function preferredVoiceMimeType(isSupported: (mimeType: string) => boolean) {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(isSupported) ?? "";
}

export function appendVoiceTranscript(current: string, transcript: string) {
  const left = current.trimEnd();
  const right = transcript.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function formatVoiceDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remainder = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function createVoiceWaveform(level = 0) {
  const safeLevel = Math.min(1, Math.max(0, level));
  return Array.from({ length: VOICE_WAVEFORM_BARS }, () => Math.round(18 + safeLevel * 82));
}

export function voiceWaveformFromTimeDomain(samples: ArrayLike<number>, barCount = VOICE_WAVEFORM_BARS) {
  if (samples.length === 0 || barCount <= 0) return [];
  return Array.from({ length: barCount }, (_, index) => {
    const start = Math.floor(index * samples.length / barCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / barCount));
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end && sampleIndex < samples.length; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex] - 128) / 128);
    }
    return Math.round(18 + Math.min(1, peak) * 82);
  });
}
