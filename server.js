// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

import firebaseAdmin from "./firebaseAdmin.js";
import {
  verifyFirebaseBearer,
  getGoogleCalendarClientForUid,
  buildGoogleOAuthClient,
  saveGoogleTokens,
  getGoogleTokens,
} from "./providerClients.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const BUILD = process.env.BUILD || "server.js-v7-add-delete-calendar-events";
const PORT = process.env.PORT || 3000;

function jsonError(res, code, error, details) {
  const payload = { ok: false, error, build: BUILD };
  if (details) payload.details = details;
  return res.status(code).json(payload);
}

app.get("/", (req, res) => {
  res
    .status(200)
    .send(`Mindenu API is running. Try /health or /v1/chat. Build: ${BUILD}`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, build: BUILD });
});

// ---------- Auth middleware ----------
async function requireAuth(req, res, next) {
  try {
    const { uid } = await verifyFirebaseBearer(req);
    req.uid = uid;
    next();
  } catch (e) {
    return jsonError(res, e.status || 401, e.message, e.details);
  }
}

// ---------- OAuth status ----------
app.get("/v1/oauth/status", requireAuth, async (req, res) => {
  try {
    const googleTokens = await getGoogleTokens(req.uid);
    return res.json({
      ok: true,
      build: BUILD,
      google: { connected: !!googleTokens },
      microsoft: { connected: false },
    });
  } catch (e) {
    return jsonError(res, 500, "server_error", e?.message || String(e));
  }
});

// ---------- Google OAuth begin ----------
app.get("/v1/oauth/google/start", requireAuth, async (req, res) => {
  try {
    const oauth2 = buildGoogleOAuthClient();

    // You can override scopes using env GOOGLE_SCOPES (space-separated)
    const scopes =
      (process.env.GOOGLE_SCOPES || "")
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean) || [];

    const finalScopes =
      scopes.length > 0
        ? scopes
        : [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/calendar",
          ];

    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: finalScopes,
      state: req.uid, // IMPORTANT: lets callback know which uid
    });

    return res.json({ ok: true, url, build: BUILD });
  } catch (e) {
    return jsonError(res, 500, "oauth_start_failed", e?.message || String(e));
  }
});

// ---------- Google OAuth callback ----------
app.get("/v1/oauth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const uid = req.query.state; // set in /start

    if (!code) return res.status(400).send("Google OAuth callback error: missing_code");
    if (!uid) return res.status(400).send("Google OAuth callback error: missing_state_uid");

    const oauth2 = buildGoogleOAuthClient();
    const { tokens } = await oauth2.getToken(code);

    await saveGoogleTokens(uid, tokens);

    return res.status(200).send("Google connected. You can return to the app.");
  } catch (e) {
    return res
      .status(500)
      .send(`Google OAuth callback error: ${e?.message || String(e)}`);
  }
});

// ---------- OpenAI helper ----------
async function callOpenAIChat({ userText, messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { assistantText: "Server is missing OPENAI_API_KEY." };
  }

  // Convert your {role,text} to OpenAI {role,content}
  const openAiMessages = [];

  // Optional system prompt
  openAiMessages.push({
    role: "system",
    content:
      "You are Mindenu, a helpful assistant. Keep answers concise and actionable.",
  });

  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      const role = m?.role;
      const text = m?.text ?? m?.content;
      if (!role || !text) continue;
      openAiMessages.push({ role, content: String(text) });
    }
  } else if (userText) {
    openAiMessages.push({ role: "user", content: String(userText) });
  }

  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: openAiMessages,
    temperature: 0.2,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    return {
      assistantText:
        data?.error?.message ||
        `OpenAI error HTTP ${r.status}: ${JSON.stringify(data)}`,
      raw: data,
    };
  }

  const assistantText =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  return { assistantText, raw: data };
}

// ---------- Calendar helper ----------
async function listCalendarEvents(calendar, timeMinISO, timeMaxISO) {
  const resp = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const items = resp?.data?.items || [];
  return items.map((ev) => ({
    id: ev.id,
    summary: ev.summary || "(No title)",
    start: ev.start?.dateTime || ev.start?.date,
    end: ev.end?.dateTime || ev.end?.date,
  }));
}

// ---------- Chat ----------
app.post("/v1/chat", requireAuth, async (req, res) => {
  try {
    // ✅ Accept BOTH formats:
    const body = req.body || {};
    const uid = req.uid; // extracted from Firebase token

    // Prefer explicit "message" if present, else take last user in "messages"
    let userText = typeof body.message === "string" ? body.message.trim() : "";

    const messages = Array.isArray(body.messages) ? body.messages : [];

    if (!userText && messages.length > 0) {
      const lastUser = [...messages].reverse().find((m) => m?.role === "user" && m?.text);
      userText = lastUser?.text?.trim() || "";
    }

    if (!userText) {
      return jsonError(res, 400, "missing_message");
    }

    // If question is clearly calendar-related, attempt calendar
    const isCalendarAsk = /calendar|schedule|events|tomorrow|today/i.test(userText);

    if (isCalendarAsk) {
      const calendar = await getGoogleCalendarClientForUid(uid);
      if (!calendar) {
        return res.json({
          ok: true,
          build: BUILD,
          assistantText:
            "Google isn’t connected on the server for this account. Tap Google Connected in the app to re-link, then try again.",
          functionCalls: [],
        });
      }

      // Minimal “tomorrow” handler (example)
      if (/tomorrow/i.test(userText)) {
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() + 1);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);

        const events = await listCalendarEvents(
          calendar,
          start.toISOString(),
          end.toISOString()
        );

        const assistantText =
          events.length === 0
            ? "You have no events tomorrow."
            : `Here are your events for tomorrow:\n` +
              events
                .map((e, i) => `${i + 1}. ${e.summary} (${e.start} → ${e.end})`)
                .join("\n");

        return res.json({
          ok: true,
          build: BUILD,
          assistantText,
          functionCalls: [],
        });
      }
    }

    // Otherwise use OpenAI
    const t0 = Date.now();
    const { assistantText, raw } = await callOpenAIChat({ userText, messages });
    const ms = Date.now() - t0;

    // ✅ NEVER return empty assistantText
    let safeText = (assistantText || "").trim();
    if (!safeText) {
      console.log("[chat] OpenAI returned empty content. raw keys:", Object.keys(raw || {}));
      safeText =
        "I didn’t get a usable response from the AI. Please try again (or rephrase slightly).";
    }

    console.log(`[chat] openai ${ms}ms`);
    console.log("[chat] assistantText length:", safeText.length);

    return res.json({
      ok: true,
      build: BUILD,
      assistantText: safeText,
      functionCalls: [],
    });
  } catch (e) {
    return jsonError(res, 500, "server_error", e?.message || String(e));
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`mindenu-api listening on :${PORT} (${BUILD})`);
});