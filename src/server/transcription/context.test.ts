import { describe, expect, it } from "vitest";
import { buildAssemblyPrompt, buildVoiceContextPrompt, buildVoiceKeyterms, extractVocabularyCorrections } from "@/server/transcription/context";

const memory = [
  { canonicalKey: "identity.full_name", content: "The user's name is Morgan Lee.", sensitivity: "normal" as const, importance: 0.9 },
  { canonicalKey: "project.atlas", content: "Atlas is the current product project.", sensitivity: "normal" as const, importance: 0.8 },
  { canonicalKey: "private.health", content: "Sensitive health detail.", sensitivity: "sensitive" as const, importance: 1 },
];

describe("voice context", () => {
  it("biases transcription toward normal-sensitivity names and projects only", () => {
    const terms = buildVoiceKeyterms(memory, [{ term: "Supabase", occurrenceCount: 2 }]);
    expect(terms).toEqual(expect.arrayContaining(["Supabase", "identity full name", "Morgan Lee", "Atlas"]));
    expect(terms).not.toContain("Sensitive health detail");
    expect(buildVoiceContextPrompt(memory)).toContain("identity full name");
  });

  it("tells the provider to preserve Hindi, English, and code switching", () => {
    const prompt = buildAssemblyPrompt("Atlas: current product");
    expect(prompt).toContain("do not translate");
    expect(prompt).toContain("Atlas");
  });

  it("extracts likely corrected vocabulary without learning ordinary prose", () => {
    expect(extractVocabularyCorrections("I met with super base", "I met with Supabase and Atlas")).toEqual(["Supabase", "Atlas"]);
  });
});
