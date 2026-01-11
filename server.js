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
  // If you still have Microsoft wired, leave these imports as your baseline already had:
  msFetchCalendarEvents,
  msCreateCalendarEvent,
  msFetchMailUnread,
  msSendEmail,
} from "./providerClients.js";

import { callOpenAI } from "./openaiClient.js";

const BUILD = "server.js-v8-google-only-delete-event";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, build: BUILD }));

app.get("/", (_req, res) => {
  res.status(200).send(`Mindenu API is running. Try /health or /v1/chat. Build: ${BUILD}`);
});

// OAuth
app.get("/v1/oauth/google/start", googleStart);
app.get("/v1/oauth/google/callback", googleCallback);

app.get("/v1/oauth/microsoft/start", microsoftStart);
app.get("/v1/oauth/microsoft/callback", microsoftCallback);

// Status
app.get("/v1/oauth/status", requireAuth, (req, res) => {
  const uid = req.user.uid;
  const google = getProviderTokens(uid, "google") != null;
  const microsoft = getProviderTokens(uid, "microsoft") != null;
  res.json({ ok: true, google, microsoft });
});

// --------------------
// /v1/chat (LEAVE AS YOUR WORKING BASELINE LOGIC)
// --------------------
app.post("/v1/chat", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { messages } = req.body || {};

    if (!Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "messages must be an array" });
    }

    const googleTokens = getProviderTokens(uid, "google");
    const msTokens = getProviderTokens(uid, "microsoft");

    let provider = null;
    let calendarEvents = [];
    let unreadEmail = [];

    if (googleTokens?.access_token) {
      provider = "google";
      try { calendarEvents = await googleFetchCalendarEvents(googleTokens.access_token); } catch {}
      try { unreadEmail = await googleFetchGmailUnread(googleTokens.access_token); } catch {}
    } else if (msTokens?.access_token) {
      provider = "microsoft";
      try { calendarEvents = await msFetchCalendarEvents(msTokens.access_token); } catch {}
      try { unreadEmail = await msFetchMailUnread(msTokens.access_token); } catch {}
    }

    const tools = [
      {
        type: "function",
        name: "propose_calendar_event",
        description: "Propose a calendar event for user confirmation before creating it.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string", enum: ["google", "microsoft"] },
            title: { type: "string" },
            startISO: { type: "string" },
            endISO: { type: "string" },
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
        description: "Propose an email draft for user confirmation before sending it.",
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
      // NOTE: we are NOT adding tool logic here for delete.
      // Deletion is done via /v1/actions/delete-event after user confirms in the UI.
    ];

    const systemMsg = [
      "You are Mindenu, a helpful personal assistant.",
      "NEVER send email or create or delete calendar events without explicit user confirmation.",
      "",
      `Connected provider: ${provider ?? "none"}`,
      "",
      "Calendar events (recent/upcoming):",
      JSON.stringify(calendarEvents ?? [], null, 2),
      "",
      "Unread email (recent):",
      JSON.stringify(unreadEmail ?? [], null, 2),
    ].join("\n");

    const openaiInput = [
      { role: "system", content: [{ type: "input_text", text: systemMsg }] },
      ...messages.map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: String(m.text ?? "") }],
      })),
    ];

    const out = await callOpenAI({ input: openaiInput, tools });

    res.json({ ok: true, openai: out });
  } catch (err) {
    res.status(500).json({ ok: false, error: "server_error", details: err?.message || String(err) });
  }
});

// --------------------
// Actions (existing)
// --------------------
app.post("/v1/actions/create-event", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, title, startISO, endISO, description, location, attendees } = req.body || {};

    if (!provider || !title || !startISO || !endISO) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "provider, title, startISO, endISO are required" });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({ ok: false, error: "not_connected", details: `No access token for provider: ${provider}` });
    }

    const payload = { title, startISO, endISO, description, location, attendees };

    let result;
    if (provider === "google") result = await googleCreateCalendarEvent(tokens.access_token, payload);
    else if (provider === "microsoft") result = await msCreateCalendarEvent(tokens.access_token, payload);
    else return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });

    res.json({ ok: true, provider, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: "create_event_failed", details: err?.message || String(err) });
  }
});

app.post("/v1/actions/send-email", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { provider, to, subject, bodyText } = req.body || {};

    if (!provider || !to || !subject || !bodyText) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "provider, to, subject, bodyText are required" });
    }

    const tokens = getProviderTokens(uid, provider);
    if (!tokens?.access_token) {
      return res.status(400).json({ ok: false, error: "not_connected", details: `No access token for provider: ${provider}` });
    }

    const payload = { to, subject, bodyText };

    let result;
    if (provider === "google") result = await googleSendEmail(tokens.access_token, payload);
    else if (provider === "microsoft") result = await msSendEmail(tokens.access_token, payload);
    else return res.status(400).json({ ok: false, error: "bad_request", details: "Unknown provider" });

    res.json({ ok: true, provider, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: "send_email_failed", details: err?.message || String(err) });
  }
});

// --------------------
// ✅ NEW: Google-only delete endpoint
// --------------------
app.post("/v1/actions/delete-event", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Accept both:
    // - { eventId: "..." }   (Google-only)
    // - { provider:"google", eventId:"..." } (if your app already sends provider)
    const { provider, eventId } = req.body || {};
    const p = provider || "google";

    if (p !== "google") {
      return res.status(400).json({ ok: false, error: "bad_request", details: "This backend is configured for Google-only deletes." });
    }
    if (!eventId) {
      return res.status(400).json({ ok: false, error: "bad_request", details: "eventId is required" });
    }

    const tokens = getProviderTokens(uid, "google");
    if (!tokens?.access_token) {
      return res.status(400).json({ ok: false, error: "not_connected", details: "No Google access token found for this user." });
    }

    const result = await googleDeleteCalendarEvent(tokens.access_token, eventId);

    res.json({ ok: true, provider: "google", result });
  } catch (err) {
    res.status(500).json({ ok: false, error: "delete_event_failed", details: err?.message || String(err) });
  }
});

// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mindenu-api listening on :${PORT} (${BUILD})`));