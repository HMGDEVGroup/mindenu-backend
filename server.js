import "dotenv/config";
import express from "express";
import cors from "cors";

import { openaiResponsesCreate } from "./openaiClient.js";
import { authMiddleware } from "./authMiddleware.js";
import {
  getProviderTokens,
  getPendingAction,
  setPendingAction,
  clearPendingAction,
} from "./tokenStore.js";

import {
  googleAuthFromTokens,
  gmailListLastN,
  gmailSend,
  calendarListEvents,
  calendarCreateEvent,
  calendarDeleteEvent,
} from "./providerClients.js";

import { registerGoogleOAuthRoutes } from "./oauthGoogle.js";
import { registerMicrosoftOAuthRoutes } from "./oauthMicrosoft.js";

const BUILD = process.env.BUILD || "server.js-v7-add-delete-calendar-events";
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(authMiddleware);

// ---- Basic routes ----
app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      `Mindenu API is running. Try /health or /v1/chat. Build: ${BUILD}`
    );
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, build: BUILD });
});

// ---- OAuth routes ----
registerGoogleOAuthRoutes(app);
registerMicrosoftOAuthRoutes(app);

// ---- Utilities ----
function nowISO() {
  return new Date().toISOString();
}

function toISOWithMinutesFromNow(minutes) {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  return d.toISOString();
}

function normalizeConfirm(text) {
  const t = (text || "").trim().toLowerCase();
  if (t === "send it" || t === "send") return "send";
  if (t === "create it" || t === "create") return "create";
  if (t === "delete it" || t === "delete") return "delete";
  return null;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- Tool definitions for OpenAI ----
function buildTools() {
  return [
    {
      type: "function",
      name: "list_last_emails",
      description: "List the last N emails from the user's inbox.",
      parameters: {
        type: "object",
        properties: {
          maxResults: { type: "integer", default: 3 },
        },
      },
    },
    {
      type: "function",
      name: "draft_email",
      description:
        "Create an email draft for the user to approve (does not send).",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      type: "function",
      name: "send_email",
      description: "Send an email (requires user confirmation flow).",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      type: "function",
      name: "list_calendar_events",
      description:
        "List calendar events within a time window (ISO strings).",
      parameters: {
        type: "object",
        properties: {
          timeMinISO: { type: "string" },
          timeMaxISO: { type: "string" },
          maxResults: { type: "integer", default: 20 },
        },
        required: ["timeMinISO", "timeMaxISO"],
      },
    },
    {
      type: "function",
      name: "propose_calendar_event",
      description:
        "Propose a calendar event (requires user confirmation before creating).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          startISO: { type: "string" },
          endISO: { type: "string" },
          timezone: { type: "string", default: "America/New_York" }
        },
        required: ["summary", "startISO", "endISO"],
      },
    },
    {
      type: "function",
      name: "create_calendar_event",
      description: "Create a calendar event (requires user confirmation flow).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          startISO: { type: "string" },
          endISO: { type: "string" },
          timezone: { type: "string", default: "America/New_York" }
        },
        required: ["summary", "startISO", "endISO"],
      },
    },
    {
      type: "function",
      name: "delete_calendar_event",
      description:
        "Delete a calendar event by eventId (requires user confirmation flow).",
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string" },
        },
        required: ["eventId"],
      },
    },
  ];
}

// ---- Provider selection ----
async function getGoogleAuthForUid(uid) {
  const tokens = await getProviderTokens(uid, "google");
  if (!tokens?.refresh_token) {
    return { ok: false, error: "unauthorized", details: "Google not connected." };
  }
  const auth = googleAuthFromTokens(tokens);
  return { ok: true, auth };
}

// ---- Tool dispatcher ----
async function dispatchToolCall({ uid, name, args }) {
  // NOTE: Google only in this version
  const ga = await getGoogleAuthForUid(uid);
  if (!ga.ok) return ga;

  const auth = ga.auth;

  switch (name) {
    case "list_last_emails": {
      const maxResults = Number(args?.maxResults || 3);
      const emails = await gmailListLastN({ auth, maxResults });
      return { ok: true, emails };
    }

    case "draft_email": {
      return { ok: true, draft: args };
    }

    case "send_email": {
      // Always store pending, require "Send it"
      await setPendingAction(uid, {
        type: "send_email",
        payload: args,
      });
      return {
        ok: true,
        needs_confirmation: true,
        instruction: 'Reply with: "Send it" to send, or tell me what to change.',
        draft: args,
      };
    }

    case "list_calendar_events": {
      const timeMinISO = String(args?.timeMinISO);
      const timeMaxISO = String(args?.timeMaxISO);
      const maxResults = Number(args?.maxResults || 20);
      const events = await calendarListEvents({ auth, timeMinISO, timeMaxISO, maxResults });
      return { ok: true, events };
    }

    case "propose_calendar_event": {
      await setPendingAction(uid, {
        type: "create_calendar_event",
        payload: args,
      });
      return {
        ok: true,
        needs_confirmation: true,
        instruction: 'Reply with: "Create it" to create the event, or tell me what to change.',
        proposal: args,
      };
    }

    case "create_calendar_event": {
      await setPendingAction(uid, {
        type: "create_calendar_event",
        payload: args,
      });
      return {
        ok: true,
        needs_confirmation: true,
        instruction: 'Reply with: "Create it" to create the event, or tell me what to change.',
        proposal: args,
      };
    }

    case "delete_calendar_event": {
      await setPendingAction(uid, {
        type: "delete_calendar_event",
        payload: args,
      });
      return {
        ok: true,
        needs_confirmation: true,
        instruction: 'Reply with: "Delete it" to delete, or tell me what to change.',
        proposal: args,
      };
    }

    default:
      return { ok: false, error: "unknown_tool", details: `No handler for ${name}` };
  }
}

// ---- Execute pending action after user confirms ----
async function executePendingAction(uid, confirmType) {
  const pending = await getPendingAction(uid);
  if (!pending) return null;

  if (confirmType === "send" && pending.type === "send_email") {
    const ga = await getGoogleAuthForUid(uid);
    if (!ga.ok) return ga;

    const { to, subject, body } = pending.payload || {};
    const sent = await gmailSend({
      auth: ga.auth,
      to,
      subject,
      bodyText: body,
    });

    await clearPendingAction(uid);
    return {
      ok: true,
      message:
        `✅ Sent.\n\nTo: ${to}\nSubject: ${subject}\n\n(Message id: ${sent.id})`,
    };
  }

  if (confirmType === "create" && pending.type === "create_calendar_event") {
    const ga = await getGoogleAuthForUid(uid);
    if (!ga.ok) return ga;

    const p = pending.payload || {};
    const created = await calendarCreateEvent({
      auth: ga.auth,
      summary: p.summary,
      description: p.description,
      location: p.location,
      startISO: p.startISO,
      endISO: p.endISO,
      timezone: p.timezone || "America/New_York",
    });

    await clearPendingAction(uid);
    return {
      ok: true,
      message:
        `✅ Calendar event created.\n\nTitle: ${p.summary}\nStart: ${p.startISO}\nEnd: ${p.endISO}`,
      event: created,
    };
  }

  if (confirmType === "delete" && pending.type === "delete_calendar_event") {
    const ga = await getGoogleAuthForUid(uid);
    if (!ga.ok) return ga;

    const { eventId } = pending.payload || {};
    if (!eventId) {
      await clearPendingAction(uid);
      return { ok: false, error: "missing_eventId" };
    }

    await calendarDeleteEvent({ auth: ga.auth, eventId });

    await clearPendingAction(uid);
    return {
      ok: true,
      message: `✅ Deleted calendar event.\n\nEvent ID: ${eventId}`,
    };
  }

  return null;
}

// ---- Robust tool loop: prevents blank responses ----
async function runChatWithTools({ uid, userText }) {
  const tools = buildTools();

  // If user is confirming a pending action, execute immediately
  const confirm = normalizeConfirm(userText);
  if (confirm) {
    const executed = await executePendingAction(uid, confirm);
    if (executed?.ok) return executed.message;
    if (executed && executed.ok === false) {
      return `Error: ${executed.error || "failed"}${executed.details ? `\n${executed.details}` : ""}`;
    }
    // If no pending matched, continue to LLM
  }

  const system = `
You are Mindenu, a helpful assistant inside an iPhone app.
You can:
- read last emails
- draft/send emails (send requires confirmation phrase "Send it")
- list calendar events
- propose/create events (create requires confirmation phrase "Create it")
- delete events (delete requires confirmation phrase "Delete it")

When you return a draft/proposal, ALWAYS include the exact confirmation instruction.

If you lack required info, ask ONE concise question.
`;

  let messages = [
    { role: "system", content: system.trim() },
    { role: "user", content: userText },
  ];

  for (let step = 0; step < 5; step++) {
    const resp = await openaiResponsesCreate({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: messages,
      tools,
      tool_choice: "auto",
    });

    const assistantText = (resp.output_text || "").trim();

    // gather tool calls
    const toolCalls = [];
    for (const item of resp.output || []) {
      if (item.type === "tool_call") toolCalls.push(item);
    }

    console.log(`[chat] openai step=${step + 1} assistantText length: ${assistantText.length}`);
    console.log(`[chat] functionCalls count: ${toolCalls.length}`);

    // Done: got text and no tool calls
    if (assistantText && toolCalls.length === 0) {
      return assistantText;
    }

    // If tool calls exist, execute them and continue
    if (toolCalls.length > 0) {
      // Add assistant output (tool_call objects) back into messages
      messages.push({ role: "assistant", content: resp.output });

      for (const tc of toolCalls) {
        const name = tc.name;
        const args = tc.arguments ? safeJsonParse(tc.arguments) : {};
        console.log(`[chat] tool_call -> ${name}`);

        let result;
        try {
          result = await dispatchToolCall({ uid, name, args });
        } catch (e) {
          result = { ok: false, error: "tool_error", details: String(e?.message || e) };
        }

        messages.push({
          role: "tool",
          name,
          tool_call_id: tc.call_id,
          content: JSON.stringify(result),
        });
      }

      // Continue loop: model should now produce user-facing text
      continue;
    }

    // No text, no tools: prevent blank return
    return "I didn’t get a response back. Please try again.";
  }

  return "I hit a tool loop limit. Please try again.";
}

// ---- Chat route used by iOS app ----
app.post("/v1/chat", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "");
    const message = String(req.body?.message || "");

    if (!uid) return res.status(400).json({ ok: false, error: "missing_uid", build: BUILD });
    if (!message) return res.status(400).json({ ok: false, error: "missing_message", build: BUILD });

    const text = await runChatWithTools({ uid, userText: message });

    return res.json({ ok: true, text, build: BUILD, ts: nowISO() });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      details: String(e?.message || e),
      build: BUILD,
    });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`mindenu-api listening on :${PORT} (${BUILD})`);
});