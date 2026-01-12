import "dotenv/config";
import express from "express";
import cors from "cors";

import { requireFirebaseAuth } from "./authMiddleware.js";
import { getProviderTokens } from "./tokenStore.js";
import { callOpenAI } from "./openaiClient.js";
import { googleStart, googleCallback } from "./oauthGoogle.js";
import { microsoftStart, microsoftCallback } from "./oauthMicrosoft.js";
import { googleFetchCalendarEvents, googleFetchGmailUnread, msFetchCalendarEvents, msFetchMailUnread } from "./providerClients.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_, res) => res.json({ ok: true, name: "mindenu-api" }));

// OAuth starts/callbacks
app.get("/v1/oauth/google/start", googleStart);
app.get("/v1/oauth/google/callback", (req, res) => googleCallback(req, res).catch(e => res.status(500).send(String(e))));
app.get("/v1/oauth/microsoft/start", microsoftStart);
app.get("/v1/oauth/microsoft/callback", (req, res) => microsoftCallback(req, res).catch(e => res.status(500).send(String(e))));

// Chat: fetch small context from connected providers, then call OpenAI
app.post("/v1/chat", requireFirebaseAuth, async (req, res) => {
  const { message, providerPreference = "auto" } = req.body || {};
  if (!message) return res.status(400).json({ error: "missing_message" });

  const uid = req.user.uid;

  // Load tokens if connected
  const g = getProviderTokens(uid, "google");
  const m = getProviderTokens(uid, "microsoft");

  const context = { google: null, microsoft: null };
  try {
    if ((providerPreference === "google" || providerPreference === "auto") && g?.access_token) {
      const [events, unread] = await Promise.all([
        googleFetchCalendarEvents(g.access_token),
        googleFetchGmailUnread(g.access_token),
      ]);
      context.google = { events, unread };
    }
  } catch (e) {
    context.google = { error: String(e.message || e) };
  }

  try {
    if ((providerPreference === "microsoft" || providerPreference === "auto") && m?.access_token) {
      const [events, unread] = await Promise.all([
        msFetchCalendarEvents(m.access_token),
        msFetchMailUnread(m.access_token),
      ]);
      context.microsoft = { events, unread };
    }
  } catch (e) {
    context.microsoft = { error: String(e.message || e) };
  }

  const tools = [
    {
      type: "function",
      name: "propose_calendar_event",
      description: "Propose a calendar event for the user to confirm",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start_iso: { type: "string" },
          end_iso: { type: "string" },
          attendees: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
          provider: { type: "string", enum: ["google", "microsoft"] }
        },
        required: ["title", "start_iso", "end_iso", "provider"]
      }
    },
    {
      type: "function",
      name: "propose_email",
      description: "Propose an email draft for the user to confirm before sending",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          provider: { type: "string", enum: ["google", "microsoft"] }
        },
        required: ["to", "subject", "body", "provider"]
      }
    }
  ];

  const input = [
    {
      role: "system",
      content: [
        { type: "text", text: "You are Mindenu, a personal assistant. Be concise. Use the provided email/calendar context. If an action is needed, call the appropriate propose_* tool (do not pretend you've executed it)." }
      ]
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Context (may be partial):\n${JSON.stringify(context, null, 2)}\n\nUser message: ${message}` }
      ]
    }
  ];

  try {
    const openai = await callOpenAI({ input, tools });
    res.json({ ok: true, openai });
  } catch (e) {
    res.status(500).json({ ok: false, error: "openai_failed", details: String(e.message || e) });
  }
});

// Action execution endpoints (starter: stub)
app.post("/v1/actions/create-event", requireFirebaseAuth, async (req, res) => {
  // Implement provider-specific event creation using stored tokens and user-confirmed payload
  res.json({ ok: false, error: "not_implemented", hint: "Implement Google Calendar API insert or Graph events POST." });
});

app.post("/v1/actions/send-email", requireFirebaseAuth, async (req, res) => {
  // Implement provider-specific email send using stored tokens and user-confirmed payload
  res.json({ ok: false, error: "not_implemented", hint: "Implement Gmail send or Graph sendMail." });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`mindenu-api listening on :${port}`));
