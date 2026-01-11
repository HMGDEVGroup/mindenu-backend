// backend-node/providerClients.js
import fetch from "node-fetch";

/**
 * ----------------------------
 * GOOGLE
 * ----------------------------
 */

export async function googleFetchCalendarEvents(accessToken, opts = {}) {
  // Default: next 3 days (today + 2)
  const days = Number(opts.days ?? 3);
  const maxResults = Number(opts.maxResults ?? 25);

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setHours(0, 0, 0, 0);

  const timeMax = new Date(timeMin);
  timeMax.setDate(timeMax.getDate() + days);
  timeMax.setHours(23, 59, 59, 999);

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(maxResults));

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Google Calendar fetch error: ${r.status} ${text}`);
  }

  const data = await r.json();

  // Normalize a compact structure for the model/UI
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((e) => ({
    id: e.id,
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? "",
    description: e.description ?? "",
    attendees: Array.isArray(e.attendees) ? e.attendees.map((a) => a.email).filter(Boolean) : [],
  }));
}

export async function googleCreateCalendarEvent(accessToken, payload) {
  const body = {
    summary: payload.title,
    description: payload.description ?? "",
    location: payload.location ?? "",
    start: { dateTime: payload.startISO },
    end: { dateTime: payload.endISO },
  };

  if (Array.isArray(payload.attendees) && payload.attendees.length) {
    body.attendees = payload.attendees.map((email) => ({ email }));
  }

  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Google Calendar create error: ${r.status} ${text}`);
  }

  const e = await r.json();
  return {
    id: e.id,
    title: e.summary ?? payload.title,
    start: e.start?.dateTime ?? e.start?.date ?? payload.startISO,
    end: e.end?.dateTime ?? e.end?.date ?? payload.endISO,
  };
}

// ✅ NEW: Delete Calendar Event
export async function googleDeleteCalendarEvent(accessToken, eventId) {
  if (!eventId) throw new Error("Missing eventId");

  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Google returns 204 No Content on success
  if (r.status === 204) return { ok: true, id: eventId };

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Google Calendar delete error: ${r.status} ${text}`);
  }

  return { ok: true, id: eventId };
}

export async function googleFetchGmailUnread(accessToken, opts = {}) {
  const max = Number(opts.max ?? 3);

  // Gmail list unread messages
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", "is:unread");
  listUrl.searchParams.set("maxResults", String(max));

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    const text = await listRes.text().catch(() => "");
    throw new Error(`Gmail unread list error: ${listRes.status} ${text}`);
  }

  const list = await listRes.json();
  const msgs = Array.isArray(list.messages) ? list.messages : [];

  // Fetch metadata for each message
  const out = [];
  for (const m of msgs) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!msgRes.ok) continue;
    const msg = await msgRes.json();

    const headers = Array.isArray(msg.payload?.headers) ? msg.payload.headers : [];
    const h = (name) => headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    out.push({
      id: msg.id,
      threadId: msg.threadId,
      from: h("From"),
      subject: h("Subject"),
      date: h("Date"),
      snippet: msg.snippet ?? "",
    });
  }

  return out;
}

function base64UrlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function googleSendEmail(accessToken, payload) {
  const to = payload.to;
  const subject = payload.subject;
  const bodyText = payload.bodyText;

  const raw =
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n` +
    `\r\n` +
    `${bodyText}\r\n`;

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Gmail send error: ${r.status} ${text}`);
  }

  const data = await r.json();
  return { id: data.id, threadId: data.threadId };
}

/**
 * ----------------------------
 * MICROSOFT (OPTIONAL)
 * ----------------------------
 * If you’re not using Microsoft yet, these can remain.
 */

export async function msFetchCalendarEvents(accessToken, opts = {}) {
  const days = Number(opts.days ?? 3);

  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  // Microsoft Graph calendarView
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$top", "25");
  url.searchParams.set("$orderby", "start/dateTime");

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`MS Calendar fetch error: ${r.status} ${text}`);
  }

  const data = await r.json();
  const items = Array.isArray(data.value) ? data.value : [];
  return items.map((e) => ({
    id: e.id,
    title: e.subject ?? "(no title)",
    start: e.start?.dateTime ?? null,
    end: e.end?.dateTime ?? null,
    location: e.location?.displayName ?? "",
    description: e.bodyPreview ?? "",
    attendees: Array.isArray(e.attendees) ? e.attendees.map((a) => a.emailAddress?.address).filter(Boolean) : [],
  }));
}

export async function msCreateCalendarEvent(accessToken, payload) {
  const body = {
    subject: payload.title,
    body: {
      contentType: "text",
      content: payload.description ?? "",
    },
    location: { displayName: payload.location ?? "" },
    start: { dateTime: payload.startISO, timeZone: "UTC" },
    end: { dateTime: payload.endISO, timeZone: "UTC" },
  };

  if (Array.isArray(payload.attendees) && payload.attendees.length) {
    body.attendees = payload.attendees.map((email) => ({
      type: "required",
      emailAddress: { address: email },
    }));
  }

  const r = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`MS Calendar create error: ${r.status} ${text}`);
  }

  const e = await r.json();
  return { id: e.id, title: e.subject ?? payload.title, start: e.start?.dateTime, end: e.end?.dateTime };
}

// ✅ NEW: Delete Calendar Event
export async function msDeleteCalendarEvent(accessToken, eventId) {
  if (!eventId) throw new Error("Missing eventId");

  const r = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Microsoft returns 204 on success
  if (r.status === 204) return { ok: true, id: eventId };

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`MS Calendar delete error: ${r.status} ${text}`);
  }

  return { ok: true, id: eventId };
}

export async function msFetchMailUnread(accessToken, opts = {}) {
  const max = Number(opts.max ?? 3);

  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages");
  url.searchParams.set("$top", String(max));
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview,isRead");
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$filter", "isRead eq false");

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`MS Mail unread error: ${r.status} ${text}`);
  }

  const data = await r.json();
  const items = Array.isArray(data.value) ? data.value : [];
  return items.map((m) => ({
    id: m.id,
    from: m.from?.emailAddress?.address ?? "",
    subject: m.subject ?? "",
    date: m.receivedDateTime ?? "",
    snippet: m.bodyPreview ?? "",
  }));
}

export async function msSendEmail(accessToken, payload) {
  const body = {
    message: {
      subject: payload.subject,
      body: { contentType: "Text", content: payload.bodyText },
      toRecipients: [{ emailAddress: { address: payload.to } }],
    },
    saveToSentItems: "true",
  };

  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`MS sendMail error: ${r.status} ${text}`);
  }

  return { ok: true };
}