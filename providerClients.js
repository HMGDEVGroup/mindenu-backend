// providerClients.js
import { google } from "googleapis";

function getGoogleOAuthClient(tokens) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI");
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials(tokens);
  return oauth2;
}

export async function getGoogleEmailLastN(tokens, n = 3) {
  const auth = getGoogleOAuthClient(tokens);
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults: n,
    labelIds: ["INBOX"],
  });

  const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean);
  const results = [];

  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata" });
    const headers = msg.data.payload?.headers || [];
    const h = (name) => headers.find((x) => x.name?.toLowerCase() === name)?.value || "";

    results.push({
      id,
      from: h("from"),
      subject: h("subject"),
      date: h("date"),
      snippet: msg.data.snippet || "",
    });
  }

  return results;
}

function makeRawEmail({ to, subject, bodyText }) {
  const lines = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    bodyText,
  ];
  const message = lines.join("\r\n");
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function sendGoogleEmail(tokens, { to, subject, bodyText }) {
  const auth = getGoogleOAuthClient(tokens);
  const gmail = google.gmail({ version: "v1", auth });

  const raw = makeRawEmail({ to, subject, bodyText });
  const resp = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return { id: resp.data.id };
}

export async function getGoogleCalendarNextDays(tokens, days = 3) {
  const auth = getGoogleOAuthClient(tokens);
  const calendar = google.calendar({ version: "v3", auth });

  const timeMin = new Date();
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + days);

  const resp = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  return (resp.data.items || []).map((ev) => ({
    id: ev.id,
    title: ev.summary || "(no title)",
    start: ev.start?.dateTime || ev.start?.date || "",
    end: ev.end?.dateTime || ev.end?.date || "",
    location: ev.location || "",
    description: ev.description || "",
  }));
}

export async function createGoogleCalendarEvent(tokens, { title, startISO, endISO, description, location, attendees }) {
  const auth = getGoogleOAuthClient(tokens);
  const calendar = google.calendar({ version: "v3", auth });

  const body = {
    summary: title,
    description: description || "",
    location: location || "",
    start: { dateTime: startISO },
    end: { dateTime: endISO },
  };

  if (Array.isArray(attendees) && attendees.length) {
    body.attendees = attendees.map((email) => ({ email }));
  }

  const resp = await calendar.events.insert({
    calendarId: "primary",
    requestBody: body,
  });

  return { id: resp.data.id };
}

export async function deleteGoogleCalendarEvent(tokens, { eventId }) {
  if (!eventId) throw new Error("Missing eventId for delete");
  const auth = getGoogleOAuthClient(tokens);
  const calendar = google.calendar({ version: "v3", auth });

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return { ok: true };
}

// Best-effort resolver: match by title and (optionally) start time within the day
export async function findGoogleCalendarEventId(tokens, { title, startISO, endISO }) {
  if (!title && !startISO) return "";

  const auth = getGoogleOAuthClient(tokens);
  const calendar = google.calendar({ version: "v3", auth });

  // Build a time window to search:
  // - if startISO present: search +/- 1 day around it
  // - else: search next 7 days
  let timeMin = new Date();
  let timeMax = new Date();
  if (startISO) {
    const s = new Date(startISO);
    timeMin = new Date(s.getTime() - 24 * 60 * 60 * 1000);
    timeMax = new Date(s.getTime() + 24 * 60 * 60 * 1000);
  } else {
    timeMax.setDate(timeMax.getDate() + 7);
  }

  const resp = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
    q: title || undefined,
  });

  const items = resp.data.items || [];

  // Try exact-ish match
  const norm = (s) => (s || "").trim().toLowerCase();
  const wantTitle = norm(title);

  // If startISO is provided, match closest start time
  if (startISO) {
    const wantStart = new Date(startISO).getTime();
    let best = null;
    for (const ev of items) {
      const evTitle = norm(ev.summary);
      const evStartStr = ev.start?.dateTime || ev.start?.date;
      if (!evStartStr) continue;
      const evStart = new Date(evStartStr).getTime();

      // title match if provided
      if (wantTitle && evTitle !== wantTitle) continue;

      const dist = Math.abs(evStart - wantStart);
      if (!best || dist < best.dist) best = { id: ev.id, dist };
    }
    return best?.id || "";
  }

  // Otherwise first title match
  if (wantTitle) {
    const hit = items.find((ev) => norm(ev.summary) === wantTitle);
    return hit?.id || "";
  }

  return "";
}