// backend-node/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import firebaseAdmin from "./firebaseAdmin.js";
import {
  makeGoogleOAuthClient,
  createOAuthState,
  consumeOAuthState,
  saveGoogleTokensForUid,
  getAuthedGoogleClientForUid,
} from "./providerClients.js";
import { google } from "googleapis";

const BUILD = process.env.BUILD_TAG || "server.js-v7-add-delete-calendar-events";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ✅ YOUR REQUESTED REQUEST LOGGER (FULLY INCLUDED)
app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  console.log(
    `[req] ${req.method} ${req.path} auth=${
      auth ? auth.slice(0, 20) + "..." : "❌ NONE"
    }`
  );
  next();
});

// ---------- Helpers ----------
function ok(res, extra = {}) {
  return res.json({ ok: true, build: BUILD, ...extra });
}

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, build: BUILD, ...extra });
}

async function requireFirebaseAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return fail(res, 401, "missing_authorization");
  }

  const idToken = header.slice("Bearer ".length).trim();
  if (!idToken) return fail(res, 401, "missing_authorization");

  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid };
    return next();
  } catch (e) {
    console.log("[auth] verifyIdToken failed:", e?.message || e);
    return fail(res, 401, "invalid_authorization");
  }
}

function randomState() {
  // short random string OK for state; stored in Firestore
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function getLastUserMessage(body) {
  // Accept either:
  //  - body.message (string)
  //  - body.messages ([{role,text}])
  if (typeof body?.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  if (Array.isArray(body?.messages)) {
    const lastUser = [...body.messages].reverse().find(m => m?.role === "user" && (m?.text || "").trim());
    if (lastUser) return (lastUser.text || "").trim();
  }
  return "";
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send(`Mindenu API is running. Try /health or /v1/chat. Build: ${BUILD}`);
});

app.get("/health", (req, res) => ok(res));

// ---------- OAuth (Google) ----------
// This MUST be REAL (not 501), or your app can't reconnect Google.

const GOOGLE_SCOPES = [
  // Gmail
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Calendar
  "https://www.googleapis.com/auth/calendar",
];

app.get("/v1/oauth/google/start", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const oauth2 = makeGoogleOAuthClient();

    const state = randomState();
    await createOAuthState(uid, state);

    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state,
    });

    // Redirect the browser to Google
    return res.redirect(url);
  } catch (e) {
    console.log("[oauth] start error:", e?.message || e);
    return fail(res, 500, "oauth_start_failed", { details: String(e?.message || e) });
  }
});

app.get("/v1/oauth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return fail(res, 400, "oauth_missing_code_or_state");
    }

    const uid = await consumeOAuthState(String(state));
    if (!uid) {
      return fail(res, 400, "oauth_invalid_state");
    }

    const oauth2 = makeGoogleOAuthClient();
    const { tokens } = await oauth2.getToken(String(code));
    await saveGoogleTokensForUid(uid, tokens);

    const redirect = process.env.APP_OAUTH_SUCCESS_REDIRECT;
    if (redirect) {
      // e.g. mindenu://oauth/google?ok=1
      return res.redirect(redirect);
    }

    // fallback: simple success page
    return res.send("✅ Google connected. You can return to the Mindenu app.");
  } catch (e) {
    console.log("[oauth] callback error:", e?.message || e);
    return res
      .status(400)
      .send(`Google OAuth callback error: ${e?.message || e}`);
  }
});

app.get("/v1/oauth/status", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const oauth = await getAuthedGoogleClientForUid(uid);
    return res.json({
      ok: true,
      build: BUILD,
      googleConnected: !!oauth,
    });
  } catch (e) {
    return fail(res, 500, "oauth_status_failed", { details: String(e?.message || e) });
  }
});

// ---------- Actions (Gmail + Calendar) ----------
app.post("/v1/actions/send-email", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const oauth2 = await getAuthedGoogleClientForUid(uid);
    if (!oauth2) return fail(res, 400, "google_not_connected");

    const { to, subject, body } = req.body || {};
    if (!to || !subject || !body) return fail(res, 400, "missing_fields");

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    const mime = [
      `To: ${to}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${subject}`,
      "",
      body,
    ].join("\r\n");

    const raw = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return ok(res);
  } catch (e) {
    console.log("[gmail] send error:", e?.message || e);
    return fail(res, 500, "gmail_send_failed", { details: String(e?.message || e) });
  }
});

app.post("/v1/actions/create-event", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const oauth2 = await getAuthedGoogleClientForUid(uid);
    if (!oauth2) return fail(res, 400, "google_not_connected");

    const { summary, startISO, endISO, description, location } = req.body || {};
    if (!summary || !startISO || !endISO) return fail(res, 400, "missing_fields");

    const calendar = google.calendar({ version: "v3", auth: oauth2 });

    const created = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description: description || "",
        location: location || "",
        start: { dateTime: startISO },
        end: { dateTime: endISO },
      },
    });

    return ok(res, { eventId: created.data.id });
  } catch (e) {
    console.log("[cal] create error:", e?.message || e);
    return fail(res, 500, "calendar_create_failed", { details: String(e?.message || e) });
  }
});

app.post("/v1/actions/delete-event", requireFirebaseAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const oauth2 = await getAuthedGoogleClientForUid(uid);
    if (!oauth2) return fail(res, 400, "google_not_connected");

    const { eventId } = req.body || {};
    if (!eventId) return fail(res, 400, "missing_eventId");

    const calendar = google.calendar({ version: "v3", auth: oauth2 });

    await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });

    return ok(res);
  } catch (e) {
    console.log("[cal] delete error:", e?.message || e);
    return fail(res, 500, "calendar_delete_failed", { details: String(e?.message || e) });
  }
});

// ---------- Chat ----------
app.post("/v1/chat", requireFirebaseAuth, async (req, res) => {
  try {
    const userText = getLastUserMessage(req.body);
    if (!userText) return fail(res, 400, "missing_message");

    // If you want your chat to *use Google*, you can do so here by calling
    // list calendar, etc. For now we just talk to OpenAI.

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return fail(res, 500, "missing_openai_key");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are Mindenu, a helpful assistant." },
          { role: "user", content: userText },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.log("[openai] error:", data);
      return fail(res, 500, "openai_error", { details: JSON.stringify(data) });
    }

    const text = data?.choices?.[0]?.message?.content || "";

    // Return in a simple envelope your iOS client can decode
    return res.json({
      ok: true,
      build: BUILD,
      assistantText: text,
    });
  } catch (e) {
    console.log("[chat] error:", e?.message || e);
    return fail(res, 500, "chat_failed", { details: String(e?.message || e) });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`mindenu-api listening on :${PORT} (${BUILD})`);
});