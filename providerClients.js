import fetch from "node-fetch";

// --------------------
// Helpers
// --------------------
function base64UrlEncode(bufferOrString) {
  const b =
    Buffer.isBuffer(bufferOrString)
      ? bufferOrString
      : Buffer.from(String(bufferOrString), "utf8");

  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// --------------------
// Google Calendar
// --------------------
export async function googleFetchCalendarEvents(accessToken) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Google calendar error: ${j?.error?.message || r.statusText}`);
  }

  return (j.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

export async function googleCreateCalendarEvent(accessToken, payload) {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");

  const body = {
    summary: payload.title || "Untitled event",
    description: payload.description || "",
    location: payload.location || "",
    start: { dateTime: payload.startISO },
    end: { dateTime: payload.endISO },
  };

  if (Array.isArray(payload.attendees) && payload.attendees.length > 0) {
    body.attendees = payload.attendees.filter(Boolean).map((email) => ({ email }));
  }

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Google create event error: ${j?.error?.message || r.statusText}`);
  }

  return { id: j.id, htmlLink: j.htmlLink, status: j.status };
}

/**
 * ✅ NEW: Delete Google Calendar event by eventId
 * Google returns 204 No Content on success.
 */
export async function googleDeleteCalendarEvent(accessToken, eventId) {
  if (!eventId) throw new Error("Missing eventId");

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(
    eventId
  )}`;

  const r = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (r.status === 204) {
    return { ok: true, deleted: true, eventId };
  }

  let j = null;
  try {
    j = await r.json();
  } catch {}

  if (!r.ok) {
    throw new Error(`Google delete event error: ${j?.error?.message || r.statusText}`);
  }

  return { ok: true, deleted: true, eventId };
}

// --------------------
// Google Gmail
// --------------------
export async function googleFetchGmailUnread(accessToken) {
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", "is:unread newer_than:7d");
  listUrl.searchParams.set("maxResults", "10");

  const list = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const listJson = await list.json();
  if (!list.ok) {
    throw new Error(`Gmail list error: ${listJson?.error?.message || list.statusText}`);
  }

  const ids = (listJson.messages || []).slice(0, 5).map((m) => m.id);
  const out = [];

  for (const id of ids) {
    const msgUrl =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
      `?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;

    const r = await fetch(msgUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const j = await r.json();
    if (!r.ok) continue;

    const headers = Object.fromEntries((j.payload?.headers || []).map((h) => [h.name, h.value]));

    out.push({
      id,
      subject: headers["Subject"] || "(no subject)",
      from: headers["From"] || "",
      date: headers["Date"] || "",
      snippet: j.snippet || "",
    });
  }

  return out;
}

export async function googleSendEmail(accessToken, payload) {
  if (!payload?.to) throw new Error("Missing 'to'");
  if (!payload?.subject) throw new Error("Missing 'subject'");
  if (!payload?.bodyText) throw new Error("Missing 'bodyText'");

  const lines = [];
  lines.push(`To: ${payload.to}`);
  if (payload.cc) lines.push(`Cc: ${payload.cc}`);
  if (payload.bcc) lines.push(`Bcc: ${payload.bcc}`);
  lines.push(`Subject: ${payload.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(payload.bodyText);

  const raw = base64UrlEncode(lines.join("\r\n"));

  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Gmail send error: ${j?.error?.message || r.statusText}`);
  }

  return { id: j.id, threadId: j.threadId, labelIds: j.labelIds || [] };
}

// --------------------
// Microsoft exports can remain if you already have them in your project.
// If you're truly Google-only, it's fine to remove Microsoft code elsewhere,
// but we are NOT touching working parts beyond adding delete.
// --------------------