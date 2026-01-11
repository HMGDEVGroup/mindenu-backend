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

const BUILD = "server.js-v8-google-delete-event";

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
  res.send("mindenu-api ok");
});

/**
 * --------------------
 * OAuth routes
 * --------------------
 */
app.get("/oauth/google/start", requireAuth, googleStart);
app.get("/oauth/google/callback", googleCallback);

app.get("/oauth/microsoft/start", requireAuth, microsoftStart);
app.get("/oauth/microsoft/callback", microsoftCallback);

/**
 * --------------------
 * Provider status
 * --------------------
 */
app.get("/v1/providers/status", requireAuth, (req, res) => {
  const uid = req.user.uid;

  const google = getProviderTokens(uid, "google");
  const microsoft = getProviderTokens(uid, "microsoft");

  res.json({
    ok: true,
    build: BUILD,
    providers: {
      google: { connected: Boolean(google?.access_token), scopes: google?.scope || "" },
      microsoft: { connected: Boolean(microsoft?.access_token), scopes: microsoft?.scope || "" },
    },
  });
});

/**
 * --------------------
 * Provider: Calendar events
 * --------------------
 */
app.get("/v1/provider/calendar", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const provider = String(req.query.provider || "").toLowerCase();

    if (!provider) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Missing provider" });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({
        ok: false,
        error: "not_connected",
        details: `No access token found for provider: ${provider}`,
      });
    }

    const days = req.query.days ? Number(req.query.days) : undefined;
    const maxResults = req.query.maxResults ? Number(req.query.maxResults) : undefined;

    let events;
    if (provider === "google") {
      events = await googleFetchCalendarEvents(tokens.access_token, { days, maxResults });
    } else if (provider === "microsoft") {
      events = await msFetchCalendarEvents(tokens.access_token, { days, maxResults });
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    res.json({ ok: true, provider, events, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "provider_calendar_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

/**
 * --------------------
 * Provider: Mail unread
 * --------------------
 */
app.get("/v1/provider/mail/unread", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const provider = String(req.query.provider || "").toLowerCase();

    if (!provider) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Missing provider" });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({
        ok: false,
        error: "not_connected",
        details: `No access token found for provider: ${provider}`,
      });
    }

    const max = req.query.max ? Number(req.query.max) : undefined;

    let messages;
    if (provider === "google") {
      messages = await googleFetchGmailUnread(tokens.access_token, { max });
    } else if (provider === "microsoft") {
      messages = await msFetchMailUnread(tokens.access_token, { max });
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    res.json({ ok: true, provider, messages, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "provider_mail_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

/**
 * --------------------
 * Provider Fetch Cache (used by /v1/chat)
 * --------------------
 */
const providerCache = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = 15_000;

function cacheKey(uid, provider) {
  return `${uid}:${provider}`;
}

/**
 * Fetch provider data with a short cache to keep /v1/chat fast.
 */
async function getProviderFetch(uid, provider, opts = {}) {
  const key = cacheKey(uid, provider);
  const now = Date.now();
  const hit = providerCache.get(key);

  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return { data: hit.data, cacheFresh: true };
  }

  const tokens = getProviderTokens(uid, provider);
  if (!tokens?.access_token) {
    return { data: null, cacheFresh: false, notConnected: true };
  }

  const days = opts.days ?? 3;
  const maxResults = opts.maxResults ?? 25;
  const maxUnread = opts.maxUnread ?? 3;

  let calendar = [];
  let unread = [];

  if (provider === "google") {
    [calendar, unread] = await Promise.all([
      googleFetchCalendarEvents(tokens.access_token, { days, maxResults }),
      googleFetchGmailUnread(tokens.access_token, { max: maxUnread }),
    ]);
  } else if (provider === "microsoft") {
    [calendar, unread] = await Promise.all([
      msFetchCalendarEvents(tokens.access_token, { days, maxResults }),
      msFetchMailUnread(tokens.access_token, { max: maxUnread }),
    ]);
  } else {
    return { data: null, cacheFresh: false };
  }

  const data = { calendar, unread };
  providerCache.set(key, { ts: now, data });

  return { data, cacheFresh: false };
}

/**
 * --------------------
 * Chat endpoint
 * --------------------
 */
app.post("/v1/chat", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    const {
      provider, // optional: "google" | "microsoft"
      messages, // Chat history from client
      model,
      temperature,
      max_tokens,
      includeProviderData,
    } = req.body || {};

    // provider data (calendar/unread)
    let providerFetch = null;
    let cacheFresh = false;

    if (includeProviderData && provider) {
      const r = await getProviderFetch(uid, provider, { days: 3, maxResults: 25, maxUnread: 3 });
      providerFetch = r.data;
      cacheFresh = Boolean(r.cacheFresh);

      if (r.notConnected) {
        providerFetch = { notConnected: true };
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
          properties: {
            title: { type: "string" },
            startISO: { type: "string", description: "ISO8601 start datetime" },
            endISO: { type: "string", description: "ISO8601 end datetime" },
            timezone: { type: "string", description: "IANA timezone, e.g. America/New_York" },
            description: { type: "string" },
            location: { type: "string" },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "Email addresses",
            },
          },
          required: ["title", "startISO", "endISO"],
        },
      },
      {
        type: "function",
        name: "propose_send_email",
        description: "Propose an email reply for user confirmation before sending. Do NOT send directly.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            replyToMessageId: { type: "string", description: "Message ID to reply to (optional)" },
          },
          required: ["to", "subject", "body"],
        },
      },
    ];

    const system = {
      role: "system",
      content:
        "You are Mindenu Assistant. Help the user with calendar and email tasks. " +
        "When you want to create a calendar event or send an email, you MUST propose it first using the available tools. " +
        "Never perform actions without explicit user confirmation. " +
        "If provider data is present, use it to answer contextually.",
    };

    const userMessages = Array.isArray(messages) ? messages : [];

    const openaiPayload = {
      model: model || "gpt-4o-mini",
      messages: [
        system,
        ...(includeProviderData && providerFetch
          ? [
              {
                role: "system",
                content: `Provider data (${provider}): ${JSON.stringify(providerFetch).slice(0, 25000)}`,
              },
            ]
          : []),
        ...userMessages,
      ],
      temperature: typeof temperature === "number" ? temperature : 0.3,
      max_tokens: typeof max_tokens === "number" ? max_tokens : 650,
      tools,
      tool_choice: "auto",
    };

    const ai = await callOpenAI(openaiPayload);

    res.json({ ok: true, ai, build: BUILD });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "chat_failed",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

/**
 * --------------------
 * Actions endpoint: Create calendar event (after user confirms)
 * --------------------
 */
app.post("/v1/actions/create-event", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, event } = req.body || {};

    if (!provider || !event) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "provider and event are required",
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
      result = await googleCreateCalendarEvent(tokens.access_token, event);
    } else if (provider === "microsoft") {
      result = await msCreateCalendarEvent(tokens.access_token, event);
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

/**
 * --------------------
 * Actions endpoint: Delete calendar event (after user confirms)
 * --------------------
 */
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

    // Google only (Microsoft not set up yet)
    if (provider !== "google") {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "Only google is supported for delete-event",
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

    const result = await googleDeleteCalendarEvent(tokens.access_token, eventId);

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

/**
 * --------------------
 * Actions endpoint: Send email (after user confirms)
 * --------------------
 */
app.post("/v1/actions/send-email", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, email } = req.body || {};

    if (!provider || !email) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "provider and email are required",
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
      result = await googleSendEmail(tokens.access_token, email);
    } else if (provider === "microsoft") {
      result = await msSendEmail(tokens.access_token, email);
    } else {
      return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });
    }

    // cache refresh
    providerCache.delete(cacheKey(uid, provider));

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