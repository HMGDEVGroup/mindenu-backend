import fetch from "node-fetch";
import { setProviderTokens } from "./tokenStore.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/**
 * Backend OAuth (web application client). iOS hits /start; user consents in browser; callback exchanges code using client secret.
 * Native apps can't keep secrets; this backend flow keeps the secret on server.
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/native-app
 */
export function googleStart(req, res) {
  const { uid, deep_link } = req.query;
  if (!uid || !deep_link) return res.status(400).send("Missing uid or deep_link");

  const state = Buffer.from(JSON.stringify({ uid, deep_link })).toString("base64url");

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", process.env.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", process.env.GOOGLE_SCOPES || "");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
}

export async function googleCallback(req, res) {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code/state");

  const { uid, deep_link } = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));

  // Exchange code for tokens
  const body = new URLSearchParams({
    code: String(code),
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const r = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) return res.status(400).send(`Token exchange failed: ${j?.error_description || j?.error || r.statusText}`);

  setProviderTokens(uid, "google", {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_in: j.expires_in,
    scope: j.scope,
    token_type: j.token_type,
  });

  // Deep link back to app
  const dl = new URL(String(deep_link));
  dl.searchParams.set("provider", "google");
  dl.searchParams.set("status", "connected");
  res.redirect(dl.toString());
}
