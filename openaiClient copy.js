// openaiClient.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.warn("[openaiClient] Missing OPENAI_API_KEY");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractFromResponsesAPI(respJson) {
  // Responses API shape:
  // resp.output: array of items like:
  //  - { type: "message", content:[{type:"output_text", text:"..."}]}
  //  - { type: "tool_call", name:"...", arguments:"{...}" }
  const output = respJson?.output || [];
  let text = "";

  for (const item of output) {
    if (item.type === "message") {
      const content = item.content || [];
      for (const c of content) {
        if (c.type === "output_text" && c.text) text += c.text;
      }
    }
  }

  const toolCalls = output
    .filter((x) => x.type === "tool_call")
    .map((x) => ({
      name: x.name,
      arguments: safeJsonParse(x.arguments) || {},
    }));

  return { assistantText: text || "", toolCalls };
}

export async function openaiChatWithTools({ uid, userMessage, tools, systemContext }) {
  const t0 = Date.now();
  const url = "https://api.openai.com/v1/responses";

  const input = [
    {
      role: "system",
      content:
        `You are Mindenu, a helpful assistant for email and calendar.\n` +
        `If you need to send an email or create/delete a calendar event, use the provided tools.\n` +
        `Never claim you completed an action unless the backend confirms it.\n` +
        `Context: ${JSON.stringify(systemContext)}\n`,
    },
    { role: "user", content: userMessage },
  ];

  const body = {
    model: OPENAI_MODEL,
    input,
    tools,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json();
  if (!r.ok) {
    throw new Error(`OpenAI error ${r.status}: ${JSON.stringify(json)}`);
  }

  const { assistantText, toolCalls } = extractFromResponsesAPI(json);
  console.log(`[chat] openai ${Date.now() - t0}ms total=${Date.now() - t0}ms`);
  return { assistantText, toolCalls };
}