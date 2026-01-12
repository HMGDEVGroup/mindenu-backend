// backend-node/server.js
//
// v6 Speed-tuned build:
// - Provider cache increased to 90s (reduces repeat Gmail/Calendar calls)
// - Smaller prompt payload (shorter snippets, fewer events, fewer messages)
// - Lower max_output_tokens (200)
// - Confirmation actions (Send it / Create it) execute without calling OpenAI (no loops)
// - Email selection (#1/#2/#3) supported, and drafts are generated without extra questions
// - Debug logs retained (assistantText length/preview/functionCalls)
//
// Copy/paste into: ~/Desktop/Mindenu_Starter_Kit/backend-node/server.js

import "dotenv/config";
import "./firebaseAdmin.js";

import express from "express";
import cors from "cors";

import { requireAuth } from "./authMiddleware.js";
import { googleStart, googleCallback } from "./oauthGoogle.js";
import { microsoftStart, microsoftCallback } from "./oauthMicrosoft.js";
import { getProviderTokens } from "./tokenStore.js";

import {
  googleFetchCalendarEvents,
  googleCreateCalendarEvent,
  googleFetchGmailUnread,
  googleSendEmail,
  msFetchCalendarEvents,
  msCreateCalendarEvent,
  msFetchMailUnread,
  msSendEmail,
} from "./providerClients.js";

import { callOpenAI } from "./openaiClient.js";

const BUILD_ID = "server.js-v6-speed-tuned";

// --------------------
// App
// --------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --------------------
// In-memory caches (per Node process)
// --------------------
const providerCache = new Map();   // uid -> { ts, provider, calendarEvents, unreadEmail }
const pendingActions = new Map();  // uid -> { ts, type, provider, payload }

// --------------------
// Tunables (speed)
// --------------------
const PROVIDER_CACHE_MS = 90_000;         // ↑ from 30s to 90s
const PENDING_ACTION_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_OUTPUT_TOKENS = 200;            // ↓ from 300 to 200
const MAX_CHAT_HISTORY = 8;               // ↓ from 10 to 8
const DAYS_AHEAD_DEFAULT = 7;             // calendar window
const GMAIL_MAX_IDS = 3;                  // email window
const PROVIDER_TIMEOUT_MS = 5000;         // provider call timeout

// --------------------
// Utils
// --------------------
function nowMs() {
  return Date.now();
}
function ms(t0) {
  return Math.round(performance.now() - t0);
}
function safeTrim(s, n = 160) { // ↓ shorter snippets for smaller prompt
  const x = String(s ?? "");
  return x.length > n ? x.slice(0, n) + "…" : x;
}
function compactEmailItems(items) {
  return (items || []).slice(0, 3).map((e) => ({
    id: e.id,
    from: safeTrim(e.from, 120),
    subject: safeTrim(e.subject, 140),
    date: e.date || e.received || "",
    snippet: safeTrim(e.snippet || e.preview || "", 160),
  }));
}
function compactEvents(items) {
  return (items || []).slice(0, 3).map((ev) => ({ // ↓ fewer events for smaller prompt
    id: ev.id,
    title: ev.summary || ev.subject || "(no title)",
    start: ev.start,
    end: ev.end,
    location: safeTrim(ev.location || "", 120),
  }));
}

function toResponsesContentParts(role, text) {
  const safeText = String(text ?? "");
  // Responses API key rule:
  // - system/user => input_text
  // - assistant   => output_text
  if (role === "assistant") return [{ type: "output_text", text: safeText }];
  return [{ type: "input_text", text: safeText }];
}

function extractAssistantText(openaiResponse) {
  try {
    // Convenient field present in many Responses outputs
    if (typeof openaiResponse?.output_text === "string" && openaiResponse.output_text.trim()) {
      return openaiResponse.output_text.trim();
    }

    const output = openaiResponse?.output;
    if (!Array.isArray(output)) return "";

    const chunks = [];
    for (const item of output) {
      if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c?.text === "string") chunks.push(c.text);
          if (c?.type === "refusal" && typeof c?.refusal === "string") chunks.push(c.refusal);
        }
      }
    }
    return chunks.join("\n").trim();
  } catch {
    return "";
  }
}

function extractFunctionCalls(openaiResponse) {
  try {
    const output = openaiResponse?.output;
    if (!Array.isArray(output)) return [];
    const calls = [];
    for (const item of output) {
      if (item?.type === "function_call") {
        calls.push({ name: item?.name, arguments: item?.arguments });
      }
    }
    return calls;
  } catch {
    return [];
  }
}

function parseArgs(argVal) {
  if (!argVal) return null;
  if (typeof argVal === "object") return argVal;
  if (typeof argVal !== "string") return null;
  try {
    return JSON.parse(argVal);
  } catch {
    return null;
  }
}

function normalizeCommand(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
}

function detectSelectionIndex(text) {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/#\s*([1-9]\d*)/);
  if (m) return parseInt(m[1], 10) - 1;
  const m2 = t.match(/\bemail\s*#?\s*([1-9]\d*)\b/);
  if (m2) return parseInt(m2[1], 10) - 1;
  const m3 = t.match(/\bmessage\s*#?\s*([1-9]\d*)\b/);
  if (m3) return parseInt(m3[1], 10) - 1;
  return null;
}

function toolCallsToFallbackText(functionCalls) {
  if (!Array.isArray(functionCalls) || functionCalls.length === 0) return "";

  const first = functionCalls[0];
  const args = parseArgs(first.arguments) || {};

  if (first.name === "propose_email") {
    const to = args.to || "(missing recipient)";
    const subject = args.subject || "(no subject)";
    const body = args.bodyText || "(no body)";
    return [
      "Here’s a draft email for your approval:",
      "",
      `To: ${to}`,
      `Subject: ${subject}`,
      "",
      body,
      "",
      'Reply with: "Send it" to send, or tell me what to change.',
    ].join("\n");
  }

  if (first.name === "propose_calendar_event") {
    const title = args.title || "(no title)";
    const startISO = args.startISO || "(missing start)";
    const endISO = args.endISO || "(missing end)";
    const location = args.location || "";
    const desc = args.description || "";
    return [
      "Here’s a calendar event proposal for your approval:",
      "",
      `Title: ${title}`,
      `Start: ${startISO}`,
      `End: ${endISO}`,
      location ? `Location: ${location}` : "",
      desc ? `Notes: ${desc}` : "",
      "",
      'Reply with: "Create it" to create the event, or tell me what to change.',
    ]
      .filter(Boolean)
      .join("\n");
  }

  return `I prepared an action proposal (${first.name}). Please confirm or tell me changes.`;
}

function setPending(uid, action) {
  pendingActions.set(uid, { ts: nowMs(), ...action });
}

function getPending(uid) {
  const p = pendingActions.get(uid);
  if (!p) return null;
  if (nowMs() - p.ts > PENDING_ACTION_TTL_MS) {
    pendingActions.delete(uid);
    return null;
  }
  return p;
}

function clearPending(uid) {
  pendingActions.delete(uid);
}

// --------------------
// Health
// --------------------
app.get("/health", (_req, res) => res.json({ ok: true, build: BUILD_ID }));

// --------------------
// OAuth routes
// --------------------
app.get("/v1/oauth/google/start", googleStart);
app.get("/v1/oauth/google/callback", googleCallback);

app.get("/v1/oauth/microsoft/start", microsoftStart);
app.get("/v1/oauth/microsoft/callback", microsoftCallback);

// --------------------
// Status
// --------------------
app.get("/v1/oauth/status", requireAuth, (req, res) => {
  const uid = req.user.uid;
  res.json({
    ok: true,
    google: getProviderTokens(uid, "google") != null,
    microsoft: getProviderTokens(uid, "microsoft") != null,
  });
});

// --------------------
// Chat (draft/propose + execute on confirmation)
// --------------------
app.post("/v1/chat", requireAuth, async (req, res) => {
  const tAll = performance.now();

  try {
    const uid = req.user.uid;
    const { messages } = req.body || {};

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "messages must be an array",
        build: BUILD_ID,
      });
    }

    const lastMsg = messages[messages.length - 1];
    const lastText = lastMsg?.text ?? "";
    const cmd = normalizeCommand(lastText);

    // ✅ Confirmations execute without calling OpenAI (fast + prevents loops)
    if (cmd === "send it" || cmd === "create it") {
      const pending = getPending(uid);

      if (!pending) {
        return res.json({
          ok: true,
          assistantText:
            'I don’t have a pending action to confirm. Ask me to draft an email or propose a calendar event first.',
          functionCalls: [],
          build: BUILD_ID,
        });
      }

      const tokens = getProviderTokens(uid, pending.provider);

      if (!tokens?.access_token) {
        clearPending(uid);
        return res.status(400).json({
          ok: false,
          error: "not_connected",
          details: `No access token found for provider: ${pending.provider}`,
          build: BUILD_ID,
        });
      }

      if (cmd === "send it") {
        if (pending.type !== "email") {
          return res.json({
            ok: true,
            assistantText: 'Your last pending action is not an email. Reply "Create it" for calendar events.',
            functionCalls: [],
            build: BUILD_ID,
          });
        }

        let result;
        if (pending.provider === "google") {
          result = await googleSendEmail(tokens.access_token, pending.payload);
        } else if (pending.provider === "microsoft") {
          result = await msSendEmail(tokens.access_token, pending.payload);
        } else {
          return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider", build: BUILD_ID });
        }

        clearPending(uid);

        return res.json({
          ok: true,
          assistantText: `✅ Sent.\n\nTo: ${pending.payload.to}\nSubject: ${pending.payload.subject}`,
          functionCalls: [],
          build: BUILD_ID,
          result,
        });
      }

      if (cmd === "create it") {
        if (pending.type !== "event") {
          return res.json({
            ok: true,
            assistantText: 'Your last pending action is not a calendar event. Reply "Send it" for email drafts.',
            functionCalls: [],
            build: BUILD_ID,
          });
        }

        let result;
        if (pending.provider === "google") {
          result = await googleCreateCalendarEvent(tokens.access_token, pending.payload);
        } else if (pending.provider === "microsoft") {
          result = await msCreateCalendarEvent(tokens.access_token, pending.payload);
        } else {
          return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider", build: BUILD_ID });
        }

        clearPending(uid);

        return res.json({
          ok: true,
          assistantText: `✅ Calendar event created.\n\nTitle: ${pending.payload.title}\nStart: ${pending.payload.startISO}\nEnd: ${pending.payload.endISO}`,
          functionCalls: [],
          build: BUILD_ID,
          result,
        });
      }
    }

    // ---- Provider context (with cache)
    const cached = providerCache.get(uid);
    const cacheFresh = Boolean(cached && nowMs() - cached.ts < PROVIDER_CACHE_MS);

    let provider = cached?.provider ?? null;
    let calendarEvents = cached?.calendarEvents ?? [];
    let unreadEmail = cached?.unreadEmail ?? [];

    const googleTokens = getProviderTokens(uid, "google");
    const msTokens = getProviderTokens(uid, "microsoft");

    const tProvider = performance.now();

    if (!cacheFresh) {
      provider = null;
      calendarEvents = [];
      unreadEmail = [];

      const timeoutMs = PROVIDER_TIMEOUT_MS;
      const daysAhead = DAYS_AHEAD_DEFAULT;

      if (googleTokens?.access_token) {
        provider = "google";
        const [cal, mail] = await Promise.all([
          googleFetchCalendarEvents(googleTokens.access_token, { daysAhead, timeoutMs }).catch(() => []),
          googleFetchGmailUnread(googleTokens.access_token, { maxIds: GMAIL_MAX_IDS, timeoutMs }).catch(() => []),
        ]);
        calendarEvents = cal;
        unreadEmail = mail;
      } else if (msTokens?.access_token) {
        provider = "microsoft";
        const [cal, mail] = await Promise.all([
          msFetchCalendarEvents(msTokens.access_token, { daysAhead, timeoutMs }).catch(() => []),
          msFetchMailUnread(msTokens.access_token, { maxItems: 5, timeoutMs }).catch(() => []),
        ]);
        calendarEvents = cal;
        unreadEmail = mail;
      }

      providerCache.set(uid, { ts: nowMs(), provider, calendarEvents, unreadEmail });
    }

    console.log(`[chat] providerFetch cacheFresh=${cacheFresh} provider=${provider ?? "none"} ${ms(tProvider)}ms`);

    // Selection detection (#1/#2/#3)
    const selIdx = detectSelectionIndex(lastText);
    const condensedEmails = compactEmailItems(unreadEmail);
    const selectedEmail =
      selIdx != null && selIdx >= 0 && selIdx < condensedEmails.length ? condensedEmails[selIdx] : null;

    // ✅ Responses API tools require top-level `name`
    const tools = [
      {
        type: "function",
        name: "propose_calendar_event",
        description: "Propose a calendar event for user confirmation. Do NOT create it directly.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string", enum: ["google", "microsoft"] },
            title: { type: "string" },
            startISO: { type: "string", description: "ISO 8601 date-time string" },
            endISO: { type: "string", description: "ISO 8601 date-time string" },
            description: { type: "string" },
            location: { type: "string" },
            attendees: { type: "array", items: { type: "string" } },
          },
          required: ["provider", "title", "startISO", "endISO"],
        },
      },
      {
        type: "function",
        name: "propose_email",
        description: "Propose an email draft for user confirmation. Do NOT send it directly.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string", enum: ["google", "microsoft"] },
            to: { type: "string" },
            subject: { type: "string" },
            bodyText: { type: "string" },
          },
          required: ["provider", "to", "subject", "bodyText"],
        },
      },
    ];

    // ✅ Stronger rules: if user specifies email #, draft immediately (no questions)
    const systemMsg = [
      "You are Mindenu, a helpful personal assistant.",
      "Keep responses concise unless the user asks for detail.",
      "",
      "Hard rules:",
      '1) NEVER send email or create calendar events without explicit confirmation ("Send it" / "Create it").',
      "2) If asked to send/create, propose using propose_email / propose_calendar_event.",
      "3) If the user specifies an email number (#1/#2/#3) or a specific sender/subject, DO NOT ask questions—draft immediately.",
      "",
      `Connected provider: ${provider ?? "none"}`,
      "",
      "Unread email (condensed list):",
      JSON.stringify(condensedEmails, null, 2),
      "",
      selectedEmail ? "Selected email (use this one):" : "Selected email: (none)",
      selectedEmail ? JSON.stringify(selectedEmail, null, 2) : "",
      "",
      "Calendar (next 7 days, condensed):",
      JSON.stringify(compactEvents(calendarEvents), null, 2),
    ]
      .filter(Boolean)
      .join("\n");

    // Smaller history = smaller prompt = faster
    const recentMessages = messages.slice(-MAX_CHAT_HISTORY);

    const openaiInput = [
      { role: "system", content: toResponsesContentParts("system", systemMsg) },
      ...recentMessages.map((m) => ({
        role: m.role,
        content: toResponsesContentParts(m.role, m.text),
      })),
    ];

    const tOpenAI = performance.now();
    const out = await callOpenAI({
      input: openaiInput,
      tools,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
    console.log(`[chat] openai ${ms(tOpenAI)}ms total=${ms(tAll)}ms`);

    const functionCalls = extractFunctionCalls(out);
    let assistantText = extractAssistantText(out);

    // Always return something the UI can render
    if (!assistantText) assistantText = toolCallsToFallbackText(functionCalls);

    // Store pending action when tool call returned
    if (Array.isArray(functionCalls) && functionCalls.length > 0) {
      const first = functionCalls[0];
      const args = parseArgs(first.arguments) || {};

      if (first.name === "propose_email") {
        const p = args.provider || provider || "google";
        setPending(uid, {
          type: "email",
          provider: p,
          payload: {
            to: args.to || "",
            subject: args.subject || "",
            bodyText: args.bodyText || "",
          },
        });
      }

      if (first.name === "propose_calendar_event") {
        const p = args.provider || provider || "google";
        setPending(uid, {
          type: "event",
          provider: p,
          payload: {
            title: args.title || "",
            startISO: args.startISO || "",
            endISO: args.endISO || "",
            description: args.description || "",
            location: args.location || "",
            attendees: Array.isArray(args.attendees) ? args.attendees : [],
          },
        });
      }
    }

    // ✅ Debug logs
    console.log("[chat] assistantText length:", (assistantText || "").length);
    console.log("[chat] assistantText preview:", (assistantText || "").slice(0, 200));
    console.log("[chat] functionCalls count:", Array.isArray(functionCalls) ? functionCalls.length : 0);

    return res.json({ ok: true, assistantText, functionCalls, build: BUILD_ID });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      details: err?.message || String(err),
      build: BUILD_ID,
    });
  }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mindenu-api listening on :${PORT} (${BUILD_ID})`));
