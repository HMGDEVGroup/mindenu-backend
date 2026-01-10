import fetch from "node-fetch";

// --------------------
// Helpers
// --------------------
function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function base64UrlEncode(bufferOrString) {
  const b =
    Buffer.isBuffer(bufferOrString)
      ? bufferOrString
      : Buffer.from(String(bufferOrString), "utf8");

  // Gmail expects base64url (RFC 4648)
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// --------------------
// Google Calendar
// opts: { daysAhead, daysBack, timeoutMs }
// --------------------
export async function googleFetchCalendarEvents(accessToken, opts = {}) {
  const daysAhead = clampInt(opts.daysAhead, 7, 1, 30);
  const daysBack = clampInt(opts.daysBack, 0, 0, 30);
  const timeoutMs = clampInt(opts.timeoutMs, 5000, 1000, 20000);

  const startMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const endMs = Date.now() + daysAhead * 24 * 60 * 60 * 1000;

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", new Date(startMs).toISOString());
  url.searchParams.set("timeMax", new Date(endMs).toISOString());
  url.searchParams.set("maxResults", "25");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const r = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`Google calendar error: ${j?.error?.message || r.statusText}`);

  return (j.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || "",
  }));
}

export async function googleCreateCalendarEvent(accessToken, payload, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 1000, 20000);

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

  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`Google create event error: ${j?.error?.message || r.statusText}`);

  return { id: j.id, htmlLink: j.htmlLink || "", status: j.status || "" };
}

// --------------------
// Google Gmail
// opts: { maxIds, timeoutMs }
// --------------------
export async function googleFetchGmailUnread(accessToken, opts = {}) {
  const maxIds = clampInt(opts.maxIds, 3, 1, 10);
  const timeoutMs = clampInt(opts.timeoutMs, 5000, 1000, 20000);

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", "is:unread newer_than:7d");
  listUrl.searchParams.set("maxResults", String(maxIds));

  const list = await fetchWithTimeout(
    listUrl,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    timeoutMs
  );

  const listJson = await list.json();
  if (!list.ok) throw new Error(`Gmail list error: ${listJson?.error?.message || list.statusText}`);

  const ids = (listJson.messages || []).map((m) => m.id);
  if (ids.length === 0) return [];

  // ✅ Fetch message metadata IN PARALLEL (much faster)
  const detailPromises = ids.map(async (id) => {
    const msgUrl =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
      `?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;

    const r = await fetchWithTimeout(
      msgUrl,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      timeoutMs
    );

    const j = await r.json();
    if (!r.ok) return null;

    const headers = Object.fromEntries((j.payload?.headers || []).map((h) => [h.name, h.value]));

    return {
      id,
      subject: headers["Subject"] || "(no subject)",
      from: headers["From"] || "",
      date: headers["Date"] || "",
      snippet: j.snippet || "",
    };
  });

  const results = await Promise.all(detailPromises);
  return results.filter(Boolean);
}

export async function googleSendEmail(accessToken, payload, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 1000, 20000);

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

  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail send error: ${j?.error?.message || r.statusText}`);

  return { id: j.id, threadId: j.threadId };
}

// --------------------
// Microsoft Graph Calendar
// opts: { daysAhead, daysBack, timeoutMs }
// --------------------
export async function msFetchCalendarEvents(accessToken, opts = {}) {
  const daysAhead = clampInt(opts.daysAhead, 7, 1, 30);
  const daysBack = clampInt(opts.daysBack, 0, 0, 30);
  const timeoutMs = clampInt(opts.timeoutMs, 5000, 1000, 20000);

  const startMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const endMs = Date.now() + daysAhead * 24 * 60 * 60 * 1000;

  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  url.searchParams.set("startDateTime", new Date(startMs).toISOString());
  url.searchParams.set("endDateTime", new Date(endMs).toISOString());
  url.searchParams.set("$top", "25");

  const r = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`MS calendar error: ${j?.error?.message || r.statusText}`);

  return (j.value || []).map((e) => ({
    id: e.id,
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || "",
  }));
}

export async function msCreateCalendarEvent(accessToken, payload, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 1000, 20000);
  const url = "https://graph.microsoft.com/v1.0/me/events";

  const body = {
    subject: payload.title || "Untitled event",
    body: { contentType: "Text", content: payload.description || "" },
    start: { dateTime: payload.startISO, timeZone: "UTC" },
    end: { dateTime: payload.endISO, timeZone: "UTC" },
  };

  if (payload.location) body.location = { displayName: payload.location };

  if (Array.isArray(payload.attendees) && payload.attendees.length > 0) {
    body.attendees = payload.attendees
      .filter(Boolean)
      .map((email) => ({
        emailAddress: { address: email },
        type: "required",
      }));
  }

  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`MS create event error: ${j?.error?.message || r.statusText}`);

  return { id: j.id, webLink: j.webLink || "" };
}

// --------------------
// Microsoft Graph Mail
// opts: { maxItems, timeoutMs }
// --------------------
export async function msFetchMailUnread(accessToken, opts = {}) {
  const maxItems = clampInt(opts.maxItems, 5, 1, 20);
  const timeoutMs = clampInt(opts.timeoutMs, 5000, 1000, 20000);

  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages");
  url.searchParams.set("$top", String(maxItems));
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview,isRead");
  url.searchParams.set("$orderby", "receivedDateTime DESC");

  const r = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    timeoutMs
  );

  const j = await r.json();
  if (!r.ok) throw new Error(`MS mail error: ${j?.error?.message || r.statusText}`);

  return (j.value || [])
    .filter((m) => m.isRead === false)
    .slice(0, maxItems)
    .map((m) => ({
      id: m.id,
      subject: m.subject || "(no subject)",
      from: m.from?.emailAddress?.address || "",
      received: m.receivedDateTime,
      preview: m.bodyPreview || "",
    }));
}

export async function msSendEmail(accessToken, payload, opts = {}) {
  const timeoutMs = clampInt(opts.timeoutMs, 8000, 1000, 20000);

  if (!payload?.to) throw new Error("Missing 'to'");
  if (!payload?.subject) throw new Error("Missing 'subject'");
  if (!payload?.bodyText) throw new Error("Missing 'bodyText'");

  const url = "https://graph.microsoft.com/v1.0/me/sendMail";

  const body = {
    message: {
      subject: payload.subject,
      body: { contentType: "Text", content: payload.bodyText },
      toRecipients: [{ emailAddress: { address: payload.to } }],
    },
    saveToSentItems: true,
  };

  const r = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );

  if (!r.ok) {
    let j = null;
    try {
      j = await r.json();
    } catch {}
    throw new Error(`MS sendMail error: ${j?.error?.message || r.statusText}`);
  }

  return { ok: true };
}
