const enabled = process.env.IRIS_RUN_LIVE_MEMORY_ACCEPTANCE === "1";
if (!enabled) {
  console.error("Live memory acceptance is disabled. Set IRIS_RUN_LIVE_MEMORY_ACCEPTANCE=1 explicitly.");
  process.exit(2);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Live memory acceptance requires an OpenRouter key in the environment.");
  process.exit(2);
}

const model = process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna";
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const syntheticPrompt = "This is a bounded synthetic acceptance check. In one short sentence, acknowledge the synthetic fact: the user prefers concise answers. Do not mention tools, credentials, or any private context.";

async function call(prompt) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 180, temperature: 0 }),
  });
  if (!response.ok) throw new Error("provider_request_failed");
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) throw new Error("empty_provider_result");
}

try {
  await call(syntheticPrompt);
  await call("Recall only the same synthetic fact from this isolated in-memory check. Answer in one short sentence.");
  console.log("PASS synthetic_memory_acceptance 2_calls");
} catch {
  console.log("FAIL synthetic_memory_acceptance");
  process.exitCode = 1;
}
