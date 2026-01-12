import fetch from "node-fetch";

/**
 * Google APIs: use access token in Authorization Bearer.
 * Microsoft Graph: same.
 *
 * Starter uses minimal examples; expand per your needs.
 */

// ---- Google ----
export async function googleFetchCalendarEvents(accessToken) {
  // List primary calendar events for next ~24h (example).
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 24*60*60*1000).toISOString();

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }});
  const j = await r.json();
  if (!r.ok) throw new Error(`Google calendar error: ${j?.error?.message || r.statusText}`);
  return (j.items || []).map(e => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

export async function googleFetchGmailUnread(accessToken) {
  // List unread messages (ids only) then fetch metadata for first few.
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", "is:unread newer_than:7d");
  listUrl.searchParams.set("maxResults", "10");

  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` }});
  const listJson = await list.json();
  if (!list.ok) throw new Error(`Gmail list error: ${listJson?.error?.message || list.statusText}`);

  const ids = (listJson.messages || []).slice(0, 5).map(m => m.id);
  const out = [];
  for (const id of ids) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
    const r = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` }});
    const j = await r.json();
    if (!r.ok) continue;
    const headers = Object.fromEntries((j.payload?.headers || []).map(h => [h.name, h.value]));
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

// ---- Microsoft Graph ----
export async function msFetchCalendarEvents(accessToken) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarview");
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 24*60*60*1000).toISOString();
  url.searchParams.set("startDateTime", start);
  url.searchParams.set("endDateTime", end);
  url.searchParams.set("$top", "10");

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }});
  const j = await r.json();
  if (!r.ok) throw new Error(`MS calendar error: ${j?.error?.message || r.statusText}`);
  return (j.value || []).map(e => ({
    id: e.id,
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || "",
  }));
}

export async function msFetchMailUnread(accessToken) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages");
  url.searchParams.set("$top", "10");
  url.searchParams.set("$select", "id,subject,from,receivedDateTime,bodyPreview,isRead");
  url.searchParams.set("$orderby", "receivedDateTime DESC");

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }});
  const j = await r.json();
  if (!r.ok) throw new Error(`MS mail error: ${j?.error?.message || r.statusText}`);
  return (j.value || []).filter(m => m.isRead === false).slice(0, 5).map(m => ({
    id: m.id,
    subject: m.subject || "(no subject)",
    from: m.from?.emailAddress?.address || "",
    received: m.receivedDateTime,
    preview: m.bodyPreview || "",
  }));
}
