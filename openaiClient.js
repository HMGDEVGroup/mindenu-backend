// backend-node/openaiClient.js

import fetch from "node-fetch";

/**
 * Calls OpenAI Responses API.
 * Docs: https://platform.openai.com/docs/api-reference/responses
 *
 * Key speed fixes:
 * - Use a faster model by default (gpt-4.1-mini or gpt-4o-mini)
 * - Enforce a hard timeout so requests can't hang 30-40s
 * - Forward max_output_tokens from server.js
 */

function pickModel() {
  // Fast defaults. You can override in .env by setting OPENAI_MODEL
  // Recommended fast models per OpenAI docs:
  // - gpt-4.1-mini (fast, strong tool calling) or
  // - gpt-4o-mini (fast, affordable)  [oai_citation:2‡OpenAI](https://platform.openai.com/docs/models/gpt-4.1-mini?utm_source=chatgpt.com)
  return process.env.OPENAI_MODEL || "gpt-4.1-mini";
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * @param {Object} params
 * @param {Array|string} params.input  Responses input (array of role/content objects or string)
 * @param {Array} params.tools         Responses tools
 * @param {number} [params.max_output_tokens]
 * @param {number} [params.timeoutMs]
 */
export async function callOpenAI({ input, tools, max_output_tokens, timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in environment");

  const model = pickModel();

  // Hard timeout default: 12 seconds (tuneable via OPENAI_TIMEOUT_MS or param)
  const hardTimeoutMs = clampInt(timeoutMs ?? process.env.OPENAI_TIMEOUT_MS, 12000, 1000, 60000);

  // Cap output (server.js is passing 300)
  const maxOut = clampInt(max_output_tokens, 300, 50, 2000);

  const body = {
    model,
    input,
    tools,
    max_output_tokens: maxOut, // used by Responses API  [oai_citation:3‡OpenAI Help Center](https://help.openai.com/en/articles/5072518?utm_source=chatgpt.com)
  };

  // Small retry for transient issues (429/500/502/503/504)
  const maxAttempts = 2;

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetchWithTimeout(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        hardTimeoutMs
      );

      const json = await r.json().catch(() => ({}));

      if (!r.ok) {
        const msg = json?.error?.message || r.statusText || "Unknown error";
        const status = r.status;

        // Retry only on transient errors
        if ([429, 500, 502, 503, 504].includes(status) && attempt < maxAttempts) {
          await sleep(300 * attempt);
          continue;
        }

        throw new Error(`OpenAI error ${status}: ${msg}`);
      }

      return json;
    } catch (err) {
      lastErr = err;

      // Timeout abort throws AbortError
      const isTimeout =
        err?.name === "AbortError" ||
        String(err?.message || "").toLowerCase().includes("aborted");

      if ((isTimeout || true) && attempt < maxAttempts) {
        await sleep(300 * attempt);
        continue;
      }

      break;
    }
  }

  throw lastErr || new Error("OpenAI request failed");
}
