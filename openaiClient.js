import fetch from "node-fetch";

/**
 * Calls OpenAI Responses API.
 * Docs: https://platform.openai.com/docs/api-reference/responses
 */
export async function callOpenAI({ input, tools }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5",
      input,
      tools,
    }),
  });

  const json = await r.json();
  if (!r.ok) {
    const msg = json?.error?.message || r.statusText;
    throw new Error(`OpenAI error ${r.status}: ${msg}`);
  }
  return json;
}
