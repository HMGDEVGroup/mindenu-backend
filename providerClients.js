import { google } from "googleapis";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function getGoogleOAuthClient() {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function googleAuthFromTokens(tokens) {
  const oauth2 = getGoogleOAuthClient();

  // tokens should include at least refresh_token
  oauth2.setCredentials({
    access_token: tokens?.access_token,
    refresh_token: tokens?.refresh_token,
    scope: tokens?.scope,
    token_type: tokens?.token_type,
    expiry_date: tokens?.expiry_date,
  });

  return oauth2;
}

export async function gmailListLastN({ auth, maxResults = 3 }) {
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "in:inbox",
  });

  const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean);
  const results = [];

  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = msg.data.payload?.headers || [];
    const h = (name) =>
      headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value || "";

    results.push({
      id,
      from: h("From"),
      subject: h("Subject"),
      date: h("Date"),
      snippet: msg.data.snippet || "",
    });
  }

  return results;
}

export async function gmailSend({
  auth,
  to,
  subject,
  bodyText,
  threadId = null,
}) {
  const gmail = google.gmail({ version: "v1", auth });

  const lines = [];
  lines.push(`To: ${to}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("MIME-Version: 1.0");
  lines.push(`Subject: ${subject}`);
  lines.push("");
  lines.push(bodyText || "");

  const raw = Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(threadId ? { threadId } : {}),
    },
  });

  return { id: res.data.id, threadId: res.data.threadId };
}

export async function calendarListEvents({
  auth,
  timeMinISO,
  timeMaxISO,
  maxResults = 20,
}) {
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: true,
    orderBy: "startTime",
    maxResults,
  });

  return (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

export async function calendarCreateEvent({
  auth,
  summary,
  description,
  location,
  startISO,
  endISO,
  timezone = "America/New_York",
}) {
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: startISO, timeZone: timezone },
      end: { dateTime: endISO, timeZone: timezone },
    },
  });

  return { id: res.data.id, htmlLink: res.data.htmlLink };
}

export async function calendarDeleteEvent({ auth, eventId }) {
  const calendar = google.calendar({ version: "v3", auth });

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
  });

  return { ok: true };
}