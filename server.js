import express from "express";
import cors from "cors";
import { openai } from "./openaiClient.js";
import { requireUID } from "./authMiddleware.js";
import { googleStartURL, googleHandleCallback } from "./oauthGoogle.js";
import {
  gmailListLastEmails,
  gmailSend,
  calendarListEvents,
  calendarCreateEvent,
  calendarDeleteEvent,
} from "./providerClients.js";

const BUILD = "server.js-v6-speed-tuned-delete-calendar-fixed";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.status(200).send("Mindenu API is running. Try /health");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, build: BUILD });
});

/** -------------------------
 * OAuth (Google)
 * ------------------------*/
app.get("/v1/oauth/google/start", (req, res) => {
  try {
    const uid = req.query.uid;
    const deep_link = req.query.deep_link;
    const url = googleStartURL({ uid, deep_link });
    res.redirect(url);
  } catch (e) {
    res.status(e.status || 500).send(String(e.message || e));
  }
});

app.get("/v1/oauth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const { deep_link } = await googleHandleCallback({ code, state });

    // Redirect back to iOS deep link
    const u = new URL(deep_link);
    u.searchParams.set("provider", "google");
    u.searchParams.set("status", "connected");
    res.redirect(u.toString());
  } catch (e) {
    res.status(e.status || 500).send(String(e.message || e));
  }
});

/** -------------------------
 * Helpers
 * ------------------------*/
function nowISO() {
  return new Date().toISOString();
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/** -------------------------
 * Tool definitions
 * ------------------------*/
const tools = [
  {
    type: "function",
    name: "list_last_emails",
    description: "List the last N emails in the user's inbox.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { maxResults: { type: "number" } },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_email",
    description:
      "Propose an email draft for user confirmation before sending it. Do NOT send it directly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
        to: { type: "string" },
        subject: { type: "string" },
        bodyText: { type: "string" },
      },
      required: ["provider", "to", "subject", "bodyText"],
    },
  },
  {
    type: "function",
    name: "send_email",
    description:
      'Send an email that the user has already approved (e.g., user said "Send it").',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
        to: { type: "string" },
        subject: { type: "string" },
        bodyText: { type: "string" },
      },
      required: ["provider", "to", "subject", "bodyText"],
    },
  },
  {
    type: "function",
    name: "list_calendar_next_days",
    description: "List calendar events for the next X days (default 3).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { days: { type: "number" } },
      required: [],
    },
  },
  {
    type: "function",
    name: "propose_calendar_event",
    description:
      "Propose a calendar event for user confirmation before creating it. Do NOT create it directly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
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
    name: "create_calendar_event",
    description:
      'Create a calendar event that the user has already approved (e.g., user said "Create it").',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
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
    name: "propose_delete_calendar_event",
    description:
      "Propose deleting a calendar event for user confirmation before deleting it. Do NOT delete it directly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
        eventId: { type: "string" },
        title: { type: "string" },
        startISO: { type: "string" },
      },
      required: ["provider", "eventId"],
    },
  },
  {
    type: "function",
    name: "delete_calendar_event",
    description:
      'Delete a calendar event that the user has already approved (e.g., user said "Delete it").',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { type: "string", enum: ["google"] },
        eventId: { type: "string" },
      },
      required: ["provider", "eventId"],
    },
  },
];

/** -------------------------
 * Chat endpoint
 * ------------------------*/
app.post("/v1/chat", requireUID, async (req, res) => {
  const uid = req.uid;
  const userText = (req.body?.text || "").toString();

  // simple in-memory session (fine for now; production should store per uid)
  global.__mindenuSessions = global.__mindenuSessions || new Map();
  const sessions = global.__mindenuSessions;

  const convo = sessions.get(uid) || [];
  convo.push({ role: "user", content: userText });

  const system = {
    role: "system",
    content:
      `You are Mindenu, an assistant inside an iPhone app.\n` +
      `You can read/send emails and manage Google Calendar using tools.\n` +
      `IMPORTANT:\n` +
      `- When the user asks to send an email, propose_email first. Only call send_email after user confirms by saying "Send it".\n` +
      `- When the user asks to create a calendar event, propose_calendar_event first. Only call create_calendar_event after user confirms by saying "Create it".\n` +
      `- When the user asks to delete a calendar event, propose_delete_calendar_event first. Only call delete_calendar_event after user confirms by saying "Delete it".\n` +
      `- Always respond with helpful text. Never return an empty response.`,
  };

  async function callModel(messages) {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    });
    return resp.choices?.[0]?.message;
  }

  async function runToolCall(toolCall) {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments || "{}");

    switch (name) {
      case "list_last_emails": {
        const maxResults = Math.max(1, Math.min(10, args.maxResults || 3));
        const emails = await gmailListLastEmails(uid, maxResults);
        return { emails };
      }

      case "propose_email": {
        return {
          proposal: {
            type: "email",
            provider: "google",
            to: args.to,
            subject: args.subject,
            bodyText: args.bodyText,
          },
          instructions:
            'Reply with: "Send it" to send, or tell me what to change.',
        };
      }

      case "send_email": {
        const r = await gmailSend(uid, {
          to: args.to,
          subject: args.subject,
          bodyText: args.bodyText,
        });
        return { sent: true, messageId: r.id };
      }

      case "list_calendar_next_days": {
        const days = Math.max(1, Math.min(14, args.days || 3));
        const timeMinISO = nowISO();
        const timeMaxISO = addDays(new Date(), days).toISOString();
        const events = await calendarListEvents(uid, { timeMinISO, timeMaxISO });
        return { days, events };
      }

      case "propose_calendar_event": {
        return {
          proposal: {
            type: "calendar_event",
            provider: "google",
            title: args.title,
            startISO: args.startISO,
            endISO: args.endISO,
            description: args.description || "",
            location: args.location || "",
            attendees: args.attendees || [],
          },
          instructions:
            'Reply with: "Create it" to create the event, or tell me what to change.',
        };
      }

      case "create_calendar_event": {
        const r = await calendarCreateEvent(uid, {
          title: args.title,
          startISO: args.startISO,
          endISO: args.endISO,
          description: args.description || "",
          location: args.location || "",
          attendees: args.attendees || [],
        });
        return { created: true, eventId: r.id };
      }

      case "propose_delete_calendar_event": {
        return {
          proposal: {
            type: "delete_calendar_event",
            provider: "google",
            eventId: args.eventId,
            title: args.title || "",
            startISO: args.startISO || "",
          },
          instructions:
            'Reply with: "Delete it" to delete this event, or tell me what to change.',
        };
      }

      case "delete_calendar_event": {
        await calendarDeleteEvent(uid, { eventId: args.eventId });
        return { deleted: true, eventId: args.eventId };
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }

  try {
    // 1) First model call
    let msg = await callModel([system, ...convo]);

    // 2) If tool calls exist, run them, then ALWAYS call model again for final text
    if (msg?.tool_calls?.length) {
      convo.push({
        role: "assistant",
        content: msg.content || "",
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        const toolResult = await runToolCall(tc);
        convo.push({
          role: "tool",
          tool_call_id: tc.id,
          content: safeJson(toolResult),
        });
      }

      // Final model response after tools
      msg = await callModel([system, ...convo]);
    }

    const assistantText =
      (msg?.content || "").trim() ||
      "✅ Done. (If you expected more detail, tell me what you want next.)";

    convo.push({ role: "assistant", content: assistantText });
    sessions.set(uid, convo.slice(-40)); // keep last 40

    res.json({ ok: true, build: BUILD, assistantText });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      ok: false,
      error: "server_error",
      details: String(e.message || e),
      build: BUILD,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`mindenu-api listening on :${PORT} (${BUILD})`);
});