import fetch from "node-fetch";
import { setProviderTokens } from "./tokenStore.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

// Safe default scopes if env var is missing/misconfigured
const DEFAULT_GOOGLE_SCOPES =
  "openid email profile " +
  "https://www.googleapis.com/auth/gmail.readonly " +
  "https://www.googleapis.com/auth/calendar.events";

export function googleStart(req, res) {
  const { uid, deep_link } = req.query;
  if (!uid || !deep_link) return res.status(400).send("Missing uid or deep_link");

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId) return res.status(500).send("Missing GOOGLE_OAUTH_CLIENT_ID");
  if (!redirectUri) return res.status(500).send("Missing GOOGLE_OAUTH_REDIRECT_URI");

  // If GOOGLE_SCOPES is missing, use defaults. Also trim to avoid blank scopes.
  const scopes = String(process.env.GOOGLE_SCOPES || DEFAULT_GOOGLE_SCOPES).trim();
  if (!scopes) return res.status(500).send("Missing GOOGLE_SCOPES (scope cannot be empty)");

  const state = Buffer.from(JSON.stringify({ uid, deep_link })).toString("base64url");

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  res.redirect(url.toString());
}

export async function googleCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    const decoded = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
    const uid = decoded.uid;
    const deep_link = decoded.deep_link;
    if (!uid || !deep_link) return res.status(400).send("Invalid state");

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

    if (!clientId) return res.status(500).send("Missing GOOGLE_OAUTH_CLIENT_ID");
    if (!clientSecret) return res.status(500).send("Missing GOOGLE_OAUTH_CLIENT_SECRET");
    if (!redirectUri) return res.status(500).send("Missing GOOGLE_OAUTH_REDIRECT_URI");

    const body = new URLSearchParams();
    body.set("code", String(code));
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    body.set("redirect_uri", redirectUri);
    body.set("grant_type", "authorization_code");

    const r = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const j = await r.json();
    if (!r.ok) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(j)}`);
    }

    setProviderTokens(uid, "google", {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_in: j.expires_in,
      scope: j.scope,
      token_type: j.token_type,
    });

    const dl = new URL(String(deep_link));
    dl.searchParams.set("provider", "google");
    dl.searchParams.set("status", "connected");
    res.redirect(dl.toString());
  } catch (err) {
    res.status(500).send(err?.message || String(err));
  }
}