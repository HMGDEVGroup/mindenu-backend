// server.js (server.js-v7-delete-calendar-tools-fixed)
// ESM module (package.json should have: "type": "module")

import express from "express";
import cors from "cors";

import { firebaseAdmin } from "./firebaseAdmin.js";
import {
  getGoogleEmailLastN,
  sendGoogleEmail,
  getGoogleCalendarNextDays,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  findGoogleCalendarEventId,
} from "./providerClients.js";

import {
  getUserProviderTokens,
  setUserProviderTokens,
  getPendingAction,
  setPendingAction,
  clearPendingAction,
} from "./tokenStore.js";

import { openaiChatWithTools } from "./openaiClient.js";

// --------------------
// Config
// --------------------
const BUILD = "server.js-v7-delete-calendar-tools-fixed";
const PORT = process.env.PORT || 3000;

// BASE_URL should be your public backend URL in prod, e.g. https://mindenu-api.onrender.com
// For local dev: http://localhost:3000
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --------------------
// Express
// --------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.status(200).send(`mindenu-api up (${BUILD})`);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, build: BUILD });
});

// --------------------
// Helpers
// --------------------
function mustString(v, name) {
  if (!v || typeof v !== "string") throw new Error(`Missing or invalid ${name}`);
  return v;
}

function normalizeUid(req) {
  // Prefer X-UID header (your iOS client can set this), fallback to body.uid.
  const uid = req.headers["x-uid"] || req.body?.uid || req.query?.uid;
  return uid ? String(uid) : "";
}

function nowISO() {
  return new Date().toISOString();
}

function looksLikeConfirm(msg) {
  const s = (msg || "").trim().toLowerCase();
  return s === "send it" || s === "create it" || s === "delete it";
}

function confirmVerb(msg) {
  const s = (msg || "").trim().toLowerCase();
  if (s === "send it") return "send_email";
  if (s === "create it") return "create_calendar_event";
  if (s === "delete it") return "delete_calendar_event";
  return "";
}

// --------------------
// Tool Schemas (OpenAI tools)
// TOP-LEVEL name is REQUIRED (you hit tools[0].name before).
// --------------------
const tools = [
  {
    type: "function",
    name: "propose_email",
    description: "Propose an email draft for user confirmation before sending. Do NOT send directly.",
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
  {
    type: "function",
    name: "propose_calendar_event",
    description: "Propose a calendar event for user confirmation before creating. Do NOT create directly.",
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
    name: "propose_calendar_delete",
    description:
      "Propose deletion of a calendar event for user confirmation before deleting. Do NOT delete directly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google", "microsoft"] },
        // eventId is best; if not provided, backend will attempt to resolve by title + time.
        eventId: { type: "string" },
        title: { type: "string" },
        startISO: { type: "string", description: "ISO 8601 date-time string" },
        endISO: { type: "string", description: "ISO 8601 date-time string" },
      },
      required: ["provider"],
    },
  },
];

// --------------------
// Chat Endpoint
// --------------------
// Expected payload from iOS:
// {
//   uid: "firebaseUid",
//   provider: "google", // optional
//   message: "user text",
//   context: { ...optional } // optional
// }
app.post("/v1/chat", async (req, res) => {
  const t0 = Date.now();
  try {
    const uid = normalizeUid(req);
    const userMessage = (req.body?.message || "").toString();
    if (!uid) return res.status(401).json({ ok: false, error: "unauthorized", details: "Missing uid" });
    if (!userMessage) return res.status(400).json({ ok: false, error: "bad_request", details: "Missing message" });

    // 1) If user is confirming an action, execute it.
    if (looksLikeConfirm(userMessage)) {
      const verb = confirmVerb(userMessage);

      const pending = await getPendingAction(uid);
      if (!pending) {
        return res.json({
          ok: true,
          assistantText: "I don’t have anything pending to confirm. Ask me to draft an email or propose a calendar action first.",
        });
      }

      if (pending.actionType !== verb) {
        return res.json({
          ok: true,
          assistantText: `I have a pending action (${pending.actionType}), but you replied "${userMessage}". Reply with the matching confirmation: ${
            pending.actionType === "send_email" ? `"Send it"` : pending.actionType === "create_calendar_event" ? `"Create it"` : `"Delete it"`
          }.`,
        });
      }

      // Execute pending action
      const execStart = Date.now();
      if (verb === "send_email") {
        if (pending.provider !== "google") {
          return res.status(400).json({ ok: false, error: "not_supported", details: "Only Google provider is implemented for send_email." });
        }
        const tokens = await getUserProviderTokens(uid, "google");
        const result = await sendGoogleEmail(tokens, {
          to: pending.to,
          subject: pending.subject,
          bodyText: pending.bodyText,
        });

        await clearPendingAction(uid);

        return res.json({
          ok: true,
          assistantText: `✅ Sent.\n\nTo: ${pending.to}\nSubject: ${pending.subject}`,
          debug: { ms: Date.now() - execStart, providerResult: result },
        });
      }

      if (verb === "create_calendar_event") {
        if (pending.provider !== "google") {
          return res.status(400).json({ ok: false, error: "not_supported", details: "Only Google provider is implemented for create_calendar_event." });
        }
        const tokens = await getUserProviderTokens(uid, "google");
        const created = await createGoogleCalendarEvent(tokens, {
          title: pending.title,
          startISO: pending.startISO,
          endISO: pending.endISO,
          description: pending.description || "",
          location: pending.location || "",
          attendees: pending.attendees || [],
        });

        await clearPendingAction(uid);

        return res.json({
          ok: true,
          assistantText:
            `✅ Calendar event created.\n\nTitle: ${pending.title}\nStart: ${pending.startISO}\nEnd: ${pending.endISO}`,
          debug: { ms: Date.now() - execStart, createdId: created?.id },
        });
      }

      if (verb === "delete_calendar_event") {
        if (pending.provider !== "google") {
          return res.status(400).json({ ok: false, error: "not_supported", details: "Only Google provider is implemented for delete_calendar_event." });
        }
        const tokens = await getUserProviderTokens(uid, "google");

        // Ensure we have an eventId, attempt resolve if missing.
        let eventId = pending.eventId;
        if (!eventId) {
          eventId = await findGoogleCalendarEventId(tokens, {
            title: pending.title,
            startISO: pending.startISO,
            endISO: pending.endISO,
          });
        }

        if (!eventId) {
          await clearPendingAction(uid);
          return res.json({
            ok: true,
            assistantText:
              "I couldn’t uniquely identify the event to delete. Please ask again and include the exact title and time (or ask me to list today’s events first).",
          });
        }

        await deleteGoogleCalendarEvent(tokens, { eventId });
        await clearPendingAction(uid);

        return res.json({
          ok: true,
          assistantText: `✅ Deleted calendar event${pending.title ? `: ${pending.title}` : ""}.`,
          debug: { ms: Date.now() - execStart, eventId },
        });
      }

      // Should not happen
      await clearPendingAction(uid);
      return res.json({ ok: true, assistantText: "Pending action cleared." });
    }

    // 2) Otherwise, run the assistant with tools enabled.
    const tokensGoogle = await getUserProviderTokens(uid, "google").catch(() => null);

    // Lightweight context (optional)
    // You can enrich with last emails + calendar when needed; keep minimal for speed.
    const systemContext = {
      now: nowISO(),
      baseUrl: BASE_URL,
      hasGoogle: !!tokensGoogle,
    };

    const { assistantText, toolCalls } = await openaiChatWithTools({
      uid,
      userMessage,
      tools,
      systemContext,
    });

    console.log(`[chat] openai total=${Date.now() - t0}ms`);
    console.log("[chat] assistantText length:", assistantText?.length ?? 0);
    console.log("[chat] assistantText preview:", (assistantText || "").slice(0, 220));
    console.log("[chat] functionCalls count:", toolCalls.length);
    if (toolCalls.length) {
      console.log(
        "[chat] toolCalls names:",
        toolCalls.map((tc) => tc.name),
      );
      console.log(
        "[chat] toolCalls args:",
        toolCalls.map((tc) => tc.arguments),
      );
    }

    // 3) If the model called a tool, handle it.
    if (toolCalls.length > 0) {
      // Handle the first tool call (you can extend to multiple if you want)
      const tc = toolCalls[0];
      const name = tc.name;
      const args = tc.arguments || {};

      if (name === "propose_email") {
        // store pending action for confirmation
        await setPendingAction(uid, {
          actionType: "send_email",
          provider: args.provider,
          to: args.to,
          subject: args.subject,
          bodyText: args.bodyText,
          createdAt: nowISO(),
        });

        return res.json({
          ok: true,
          assistantText:
            `Here’s a draft email for your approval:\n\n` +
            `To: ${args.to}\n` +
            `Subject: ${args.subject}\n\n` +
            `${args.bodyText}\n\n` +
            `Reply with: "Send it" to send, or tell me what to change.`,
        });
      }

      if (name === "propose_calendar_event") {
        await setPendingAction(uid, {
          actionType: "create_calendar_event",
          provider: args.provider,
          title: args.title,
          startISO: args.startISO,
          endISO: args.endISO,
          description: args.description || "",
          location: args.location || "",
          attendees: args.attendees || [],
          createdAt: nowISO(),
        });

        return res.json({
          ok: true,
          assistantText:
            `Here’s a calendar event proposal for your approval:\n` +
            `Title: ${args.title}\n` +
            `Start: ${args.startISO}\n` +
            `End: ${args.endISO}\n\n` +
            `Reply with: "Create it" to create the event, or tell me what to change.`,
        });
      }

      if (name === "propose_calendar_delete") {
        // If eventId is absent, we can attempt to resolve later at execution time
        // but it helps to resolve now too (best UX).
        let eventId = args.eventId || "";
        if (!eventId && args.provider === "google" && tokensGoogle) {
          eventId = await findGoogleCalendarEventId(tokensGoogle, {
            title: args.title,
            startISO: args.startISO,
            endISO: args.endISO,
          }).catch(() => "");
        }

        await setPendingAction(uid, {
          actionType: "delete_calendar_event",
          provider: args.provider,
          eventId: eventId || "",
          title: args.title || "",
          startISO: args.startISO || "",
          endISO: args.endISO || "",
          createdAt: nowISO(),
        });

        return res.json({
          ok: true,
          assistantText:
            `Here’s a calendar deletion proposal for your approval:\n\n` +
            `${args.title ? `Title: ${args.title}\n` : ""}` +
            `${args.startISO ? `Start: ${args.startISO}\n` : ""}` +
            `${args.endISO ? `End: ${args.endISO}\n` : ""}` +
            `\nReply with: "Delete it" to delete this event, or tell me what to change.`,
        });
      }

      // 🔥 Critical fallback: NEVER return blank assistantText
      return res.json({
        ok: true,
        assistantText:
          `I tried to run an action (${name}), but the backend doesn't support it yet.\n` +
          `Check Render logs for toolCalls and add a handler.`,
        debug: { tool: name, args },
      });
    }

    // 4) No tool call -> return assistantText
    // Ensure not blank
    const safeText = (assistantText || "").trim();
    return res.json({
      ok: true,
      assistantText: safeText.length ? safeText : "I didn’t generate a response. Try again with a bit more detail.",
    });
  } catch (err) {
    console.error("[chat] ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      details: err?.message || String(err),
      build: BUILD,
    });
  }
});

// --------------------
// OPTIONAL: Basic calendar/email endpoints (useful for testing)
// --------------------
app.get("/v1/google/emails/last/:n", async (req, res) => {
  try {
    const uid = normalizeUid(req);
    if (!uid) return res.status(401).json({ ok: false, error: "unauthorized", details: "Missing uid" });
    const n = Math.max(1, Math.min(20, Number(req.params.n || 3)));
    const tokens = await getUserProviderTokens(uid, "google");
    const emails = await getGoogleEmailLastN(tokens, n);
    res.json({ ok: true, emails });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error", details: e?.message || String(e), build: BUILD });
  }
});

app.get("/v1/google/calendar/next/:days", async (req, res) => {
  try {
    const uid = normalizeUid(req);
    if (!uid) return res.status(401).json({ ok: false, error: "unauthorized", details: "Missing uid" });
    const days = Math.max(1, Math.min(14, Number(req.params.days || 3)));
    const tokens = await getUserProviderTokens(uid, "google");
    const events = await getGoogleCalendarNextDays(tokens, days);
    res.json({ ok: true, events });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error", details: e?.message || String(e), build: BUILD });
  }
});

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  console.log(`mindenu-api listening on :${PORT} (${BUILD})`);
});