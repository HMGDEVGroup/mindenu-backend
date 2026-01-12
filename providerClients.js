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
    throw new Error(`Google Calendar events error: ${r.status} ${text}`);
  }

  const data = await r.json();

  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((e) => ({
    id: e.id,
    title: e.summary || "(No title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || "",
    description: e.description || "",
    htmlLink: e.htmlLink || "",
  }));
}

export async function googleCreateCalendarEvent(accessToken, payload) {
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  const body = {
    summary: payload.title,
    description: payload.description || "",
    location: payload.location || "",
    start: {
      dateTime: payload.startISO,
      timeZone: payload.timezone || "America/New_York",
    },
    end: {
      dateTime: payload.endISO,
      timeZone: payload.timezone || "America/New_York",
    },
    attendees: Array.isArray(payload.attendees)
      ? payload.attendees.map((email) => ({ email }))
      : undefined,
  };

  const r = await fetch(url, {
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

  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

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
    throw new Error(`Gmail list unread error: ${listRes.status} ${text}`);
  }

  const list = await listRes.json();
  const ids = Array.isArray(list.messages) ? list.messages.map((m) => m.id).filter(Boolean) : [];

  // Fetch details for each message
  const out = [];
  for (const id of ids) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!msgRes.ok) continue;
    const msg = await msgRes.json();

    const headers = Array.isArray(msg.payload?.headers) ? msg.payload.headers : [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";

    out.push({
      id: msg.id,
      threadId: msg.threadId,
      subject,
      from,
      snippet: msg.snippet || "",
    });
  }

  return out;
}

function base64UrlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function googleSendEmail(accessToken, email) {
  // email: { to:[], subject, body, replyToMessageId? }
  const to = Array.isArray(email.to) ? email.to.join(", ") : String(email.to || "");
  const subject = email.subject || "";
  const body = email.body || "";

  const raw = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    body,
  ].join("\r\n");

  const payload = { raw: base64UrlEncode(raw) };

  // If replying, set threadId and In-Reply-To / References headers via "raw"
  // (kept as-is: your existing working behavior)

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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
 * MICROSOFT
 * ----------------------------
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
    throw new Error(`Microsoft calendarView error: ${r.status} ${text}`);
  }

  const data = await r.json();
  const items = Array.isArray(data.value) ? data.value : [];

  return items.map((e) => ({
    id: e.id,
    title: e.subject || "(No title)",
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || "",
    description: e.bodyPreview || "",
    htmlLink: e.webLink || "",
  }));
}

export async function msCreateCalendarEvent(accessToken, payload) {
  const url = "https://graph.microsoft.com/v1.0/me/events";

  const body = {
    subject: payload.title,
    body: {
      contentType: "HTML",
      content: payload.description || "",
    },
    start: {
      dateTime: payload.startISO,
      timeZone: payload.timezone || "America/New_York",
    },
    end: {
      dateTime: payload.endISO,
      timeZone: payload.timezone || "America/New_York",
    },
    location: {
      displayName: payload.location || "",
    },
    attendees: Array.isArray(payload.attendees)
      ? payload.attendees.map((email) => ({
          emailAddress: { address: email, name: email },
          type: "required",
        }))
      : [],
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Microsoft create event error: ${r.status} ${text}`);
  }

  const e = await r.json();
  return {
    id: e.id,
    title: e.subject ?? payload.title,
    start: e.start?.dateTime ?? payload.startISO,
    end: e.end?.dateTime ?? payload.endISO,
  };
}

// ✅ NEW: Delete Calendar Event
export async function msDeleteCalendarEvent(accessToken, eventId) {
  if (!eventId) throw new Error("Missing eventId");

  const r = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Graph returns 204 No Content on success
  if (r.status === 204) return { ok: true, id: eventId };

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Microsoft delete event error: ${r.status} ${text}`);
  }

  return { ok: true, id: eventId };
}

export async function msFetchMailUnread(accessToken, opts = {}) {
  const max = Number(opts.max ?? 3);

  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$top", String(max));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$filter", "isRead eq false");
  url.searchParams.set("$select", "id,subject,from,bodyPreview,conversationId");

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Microsoft unread mail error: ${r.status} ${text}`);
  }

  const data = await r.json();
  const items = Array.isArray(data.value) ? data.value : [];

  return items.map((m) => ({
    id: m.id,
    threadId: m.conversationId,
    subject: m.subject || "",
    from: m.from?.emailAddress?.address || "",
    snippet: m.bodyPreview || "",
  }));
}

export async function msSendEmail(accessToken, email) {
  // email: { to:[], subject, body }
  const to = Array.isArray(email.to) ? email.to : [];
  const subject = email.subject || "";
  const body = email.body || "";

  const payload = {
    message: {
      subject,
      body: {
        contentType: "Text",
        content: body,
      },
      toRecipients: to.map((addr) => ({
        emailAddress: { address: addr },
      })),
    },
    saveToSentItems: "true",
  };

  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Microsoft sendMail error: ${r.status} ${text}`);
  }

  return { ok: true };
}