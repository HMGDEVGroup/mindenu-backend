import { google } from "googleapis";
import { getTokens } from "./tokenStore.js";
import { googleOAuthClientFromTokens } from "./oauthGoogle.js";

export async function getGoogleClients(uid) {
  const tokens = await getTokens({ uid, provider: "google" });
  if (!tokens) {
    const err = new Error("Google not connected for this user");
    err.status = 401;
    throw err;
  }

  const auth = googleOAuthClientFromTokens(tokens);
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  return { gmail, calendar };
}

export async function gmailListLastEmails(uid, maxResults = 3) {
  const { gmail } = await getGoogleClients(uid);
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  const ids = list.data.messages?.map((m) => m.id).filter(Boolean) || [];
  const out = [];

  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = msg.data.payload?.headers || [];
    const getH = (name) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

    out.push({
      id,
      from: getH("From") || "",
      subject: getH("Subject") || "",
      date: getH("Date") || "",
      snippet: msg.data.snippet || "",
    });
  }

  return out;
}

function toBase64Url(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function gmailSend(uid, { to, subject, bodyText }) {
  const { gmail } = await getGoogleClients(uid);

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    bodyText,
  ].join("\n");

  try {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: toBase64Url(raw) },
    });
    return { id: res.data.id };
  } catch (e) {
    const msg = e?.message || String(e);
    const err = new Error(`Gmail send error: ${msg}`);
    err.status = 500;
    throw err;
  }
}

export async function calendarListEvents(uid, { timeMinISO, timeMaxISO }) {
  const { calendar } = await getGoogleClients(uid);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const items = res.data.items || [];
  return items.map((ev) => ({
    id: ev.id,
    title: ev.summary || "(No title)",
    start: ev.start?.dateTime || ev.start?.date || "",
    end: ev.end?.dateTime || ev.end?.date || "",
    location: ev.location || "",
    description: ev.description || "",
  }));
}

export async function calendarCreateEvent(uid, { title, startISO, endISO, description, location, attendees }) {
  const { calendar } = await getGoogleClients(uid);

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: title,
      description: description || "",
      location: location || "",
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: (attendees || []).map((email) => ({ email })),
    },
  });

  return { id: res.data.id };
}

export async function calendarDeleteEvent(uid, { eventId }) {
  const { calendar } = await getGoogleClients(uid);

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return { ok: true };
}