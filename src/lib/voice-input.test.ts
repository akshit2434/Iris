import { describe, expect, it } from "vitest";
import { appendVoiceTranscript, createVoiceWaveform, formatVoiceDuration, normalizeVoiceMimeType, preferredVoiceMimeType, voiceWaveformFromTimeDomain } from "@/lib/voice-input";

describe("voice input helpers", () => {
  it("selects the best browser recording format", () => {
    expect(preferredVoiceMimeType((value) => value === "audio/mp4")).toBe("audio/mp4");
    expect(preferredVoiceMimeType(() => false)).toBe("");
    expect(normalizeVoiceMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeVoiceMimeType(" AUDIO/MP4 ; codecs=opus ")).toBe("audio/mp4");
  });

  it("appends dictated text without destroying a typed draft", () => {
    expect(appendVoiceTranscript("Plan this", "for tomorrow")).toBe("Plan this for tomorrow");
    expect(appendVoiceTranscript("", "  नमस्ते  ")).toBe("नमस्ते");
  });

  it("formats the recording clock", () => {
    expect(formatVoiceDuration(0)).toBe("00:00");
    expect(formatVoiceDuration(75)).toBe("01:15");
  });

  it("converts microphone samples into bounded waveform bars", () => {
    expect(voiceWaveformFromTimeDomain(new Uint8Array([128, 128, 255, 0]), 2)).toEqual([18, 100]);
    expect(createVoiceWaveform()).toHaveLength(28);
    expect(createVoiceWaveform(2).every((value) => value === 100)).toBe(true);
  });
});
