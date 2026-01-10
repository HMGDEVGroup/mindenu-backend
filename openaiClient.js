import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export async function openaiResponsesCreate(payload) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(
      `OpenAI error (${resp.status}): ${JSON.stringify(json).slice(0, 2000)}`
    );
  }
  return json;
}