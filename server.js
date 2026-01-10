// backend-node/server.js
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
  googleDeleteCalendarEvent, // ✅ NEW
  googleFetchGmailUnread,
  googleSendEmail,
  msFetchCalendarEvents,
  msCreateCalendarEvent,
  msDeleteCalendarEvent, // ✅ NEW
  msFetchMailUnread,
  msSendEmail,
} from "./providerClients.js";

import { callOpenAI } from "./openaiClient.js";

const BUILD = "server.js-v7-add-delete-calendar-events";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * --------------------
 * Health
 * --------------------
 */
app.get("/", (_req, res) => {
  // So the Render "web page" doesn't show Cannot GET /
  res.status(200).send("mindenu-api OK");
});

app.get("/health", (_req, res) => res.json({ ok: true, build: BUILD }));

/**
 * --------------------
 * OAuth routes
 * --------------------
 */
app.get("/v1/oauth/google/start", googleStart);
app.get("/v1/oauth/google/callback", googleCallback);

app.get("/v1/oauth/microsoft/start", microsoftStart);
app.get("/v1/oauth/microsoft/callback", microsoftCallback);

/**
 * --------------------
 * Connection status
 * --------------------
 */
app.get("/v1/oauth/status", requireAuth, (req, res) => {
  const uid = req.user.uid;
  const google = getProviderTokens(uid, "google") != null;
  const microsoft = getProviderTokens(uid, "microsoft") != null;
  res.json({ ok: true, google, microsoft });
});

/**
 * --------------------
 * Helpers (Responses API extraction)
 * --------------------
 */
function extractAssistantText(openaiResponse) {
  try {
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
        calls.push({
          name: item?.name,
          arguments: item?.arguments,
        });
      }
    }
    return calls;
  } catch {
    return [];
  }
}

function toResponsesContentParts(role, text) {
  const safeText = String(text ?? "");
  if (role === "assistant") return [{ type: "output_text", text: safeText }];
  return [{ type: "input_text", text: safeText }];
}

/**
 * --------------------
 * Simple in-memory cache to speed provider fetch
 * (uid+provider -> cached data for N seconds)
 * --------------------
 */
const providerCache = new Map();
// key: `${uid}:${provider}` -> { ts, calendarEvents, unreadEmail }
const CACHE_TTL_MS = Number(process.env.PROVIDER_CACHE_TTL_MS ?? 15_000);

function cacheKey(uid, provider) {
  return `${uid}:${provider}`;
}

function getCache(uid, provider) {
  const k = cacheKey(uid, provider);
  const v = providerCache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    providerCache.delete(k);
    return null;
  }
  return v;
}

function setCache(uid, provider, calendarEvents, unreadEmail) {
  providerCache.set(cacheKey(uid, provider), {
    ts: Date.now(),
    calendarEvents,
    unreadEmail,
  });
}

/**
 * --------------------
 * Chat endpoint
 * --------------------
 */
app.post("/v1/chat", requireAuth, async (req, res) => {
  const t0 = Date.now();

  try {
    const uid = req.user.uid;
    const { messages } = req.body || {};

    if (!Array.isArray(messages)) {
      return res
        .status(400)
        .json({ ok: false, error: "bad_request", details: "messages must be an array" });
    }

    // Provider choice
    const googleTokens = getProviderTokens(uid, "google");
    const msTokens = getProviderTokens(uid, "microsoft");

    let provider = null;
    if (googleTokens?.access_token) provider = "google";
    else if (msTokens?.access_token) provider = "microsoft";

    // Fetch provider context (cached)
    let calendarEvents = [];
    let unreadEmail = [];
    let cacheFresh = false;

    if (provider) {
      const cached = getCache(uid, provider);
      if (cached) {
        calendarEvents = cached.calendarEvents;
        unreadEmail = cached.unreadEmail;
        cacheFresh = true;
      } else {
        const tfetch0 = Date.now();
        try {
          if (provider === "google") {
            calendarEvents = await googleFetchCalendarEvents(googleTokens.access_token, { days: 3, maxResults: 25 });
            unreadEmail = await googleFetchGmailUnread(googleTokens.access_token, { max: 3 });
          } else {
            calendarEvents = await msFetchCalendarEvents(msTokens.access_token, { days: 3 });
            unreadEmail = await msFetchMailUnread(msTokens.access_token, { max: 3 });
          }
        } catch {
          calendarEvents = [];
          unreadEmail = [];
        }
        setCache(uid, provider, calendarEvents, unreadEmail);
        console.log(`[chat] providerFetch cacheFresh=false provider=${provider} ${Date.now() - tfetch0}ms`);
      }
    }

    if (provider && cacheFresh) {
      console.log(`[chat] providerFetch cacheFresh=true provider=${provider} 0ms`);
    }

    // ✅ Tools (TOP-LEVEL name/description/parameters)
    const tools = [
      {
        type: "function",
        name: "propose_calendar_event",
        description: "Propose a calendar event for user confirmation before creating it. Do NOT create it directly.",
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
        description: "Propose an email draft for user confirmation before sending it. Do NOT send it directly.",
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
      // ✅ NEW: propose delete calendar event
      {
        type: "function",
        name: "propose_delete_calendar_event",
        description:
          "Propose deleting a calendar event for user confirmation. Do NOT delete it directly. Include eventId and title and startISO if possible.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string", enum: ["google", "microsoft"] },
            eventId: { type: "string", description: "Calendar provider event ID" },
            title: { type: "string" },
            startISO: { type: "string", description: "ISO 8601 start time if known" },
          },
          required: ["provider", "eventId"],
        },
      },
    ];

    const systemMsg = [
      "You are Mindenu, a helpful personal assistant.",
      "You can summarize email and calendar, draft replies, and propose actions.",
      "",
      "Hard rules:",
      "1) NEVER send an email without explicit user confirmation.",
      "2) NEVER create a calendar event without explicit user confirmation.",
      "3) NEVER delete a calendar event without explicit user confirmation.",
      "",
      "Confirm phrases:",
      '- To send an email: user says exactly "Send it".',
      '- To create an event: user says exactly "Create it".',
      '- To delete an event: user says exactly "Delete it".',
      "",
      `Connected provider: ${provider ?? "none"}`,
      "",
      "Calendar events (next 3 days):",
      JSON.stringify(calendarEvents ?? [], null, 2),
      "",
      "Unread email (last 3):",
      JSON.stringify(unreadEmail ?? [], null, 2),
      "",
      "Important:",
      "If the user asks to delete an event, ALWAYS propose using propose_delete_calendar_event and include the correct eventId from the calendar list when possible.",
    ].join("\n");

    const openaiInput = [
      { role: "system", content: toResponsesContentParts("system", systemMsg) },
      ...messages.map((m) => ({
        role: m.role,
        content: toResponsesContentParts(m.role, m.text),
      })),
    ];

    const tOpenAI0 = Date.now();
    const out = await callOpenAI({
      input: openaiInput,
      tools,
    });
    console.log(`[chat] openai ${Date.now() - tOpenAI0}ms total=${Date.now() - t0}ms`);

    const assistantText = extractAssistantText(out);
    const functionCalls = extractFunctionCalls(out);

    console.log(`[chat] assistantText length: ${assistantText?.length ?? 0}`);
    console.log(`[chat] assistantText preview: ${(assistantText ?? "").slice(0, 220).replace(/\s+/g, " ")}`);
    console.log(`[chat] functionCalls count: ${functionCalls.length}`);

    res.json({
      ok: true,
      assistantText,
      functionCalls,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "server_error",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

/**
 * --------------------
 * Actions (execute only after user confirmation)
 * --------------------
 */

// Create calendar event (after user confirms)
app.post("/v1/actions/create-event", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, title, startISO, endISO, description, location, attendees } = req.body || {};

    if (!provider || !title || !startISO || !endISO) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "provider, title, startISO, endISO are required",
      });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({
        ok: false,
        error: "not_connected",
        details: `No access token found for provider: ${provider}`,
      });
    }

    const payload = { title, startISO, endISO, description, location, attendees };

    let result;
    if (provider === "google") {
      result = await googleCreateCalendarEvent(tokens.access_token, payload);
    } else if (provider === "microsoft") {
      result = await msCreateCalendarEvent(tokens.access_token, payload);
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    // cache refresh
    providerCache.delete(cacheKey(uid, provider));

    res.json({ ok: true, provider, result, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "create_event_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

// ✅ NEW: Delete calendar event (after user confirms)
app.post("/v1/actions/delete-event", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, eventId } = req.body || {};

    if (!provider || !eventId) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "provider and eventId are required",
      });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({
        ok: false,
        error: "not_connected",
        details: `No access token found for provider: ${provider}`,
      });
    }

    let result;
    if (provider === "google") {
      result = await googleDeleteCalendarEvent(tokens.access_token, eventId);
    } else if (provider === "microsoft") {
      result = await msDeleteCalendarEvent(tokens.access_token, eventId);
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    // cache refresh
    providerCache.delete(cacheKey(uid, provider));

    res.json({ ok: true, provider, result, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "delete_event_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

// Send email (after user confirms)
app.post("/v1/actions/send-email", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, to, subject, bodyText } = req.body || {};

    if (!provider || !to || !subject || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "provider, to, subject, bodyText are required",
      });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({
        ok: false,
        error: "not_connected",
        details: `No access token found for provider: ${provider}`,
      });
    }

    const payload = { to, subject, bodyText };

    let result;
    if (provider === "google") {
      result = await googleSendEmail(tokens.access_token, payload);
    } else if (provider === "microsoft") {
      result = await msSendEmail(tokens.access_token, payload);
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    res.json({ ok: true, provider, result, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "send_email_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

/**
 * --------------------
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mindenu-api listening on :${PORT} (${BUILD})`));
