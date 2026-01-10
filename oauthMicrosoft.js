import fetch from "node-fetch";
import { setProviderTokens } from "./tokenStore.js";

function msAuthorizeUrl() {
  const tenant = process.env.MS_OAUTH_TENANT || "common";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}
function msTokenUrl() {
  const tenant = process.env.MS_OAUTH_TENANT || "common";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/**
 * Backend OAuth (confidential client) for Microsoft identity platform.
 * Docs (auth code flow): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 */
export function microsoftStart(req, res) {
  const { uid, deep_link } = req.query;
  if (!uid || !deep_link) return res.status(400).send("Missing uid or deep_link");

  const state = Buffer.from(JSON.stringify({ uid, deep_link })).toString("base64url");

  const url = new URL(msAuthorizeUrl());
  url.searchParams.set("client_id", process.env.MS_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.MS_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", process.env.MS_SCOPES || "");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
}

export async function microsoftCallback(req, res) {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code/state");

  const { uid, deep_link } = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));

  const body = new URLSearchParams({
    client_id: process.env.MS_OAUTH_CLIENT_ID,
    client_secret: process.env.MS_OAUTH_CLIENT_SECRET,
    code: String(code),
    redirect_uri: process.env.MS_OAUTH_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: process.env.MS_SCOPES || "",
  });

  const r = await fetch(msTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) return res.status(400).send(`Token exchange failed: ${j?.error_description || j?.error || r.statusText}`);

  setProviderTokens(uid, "microsoft", {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_in: j.expires_in,
    scope: j.scope,
    token_type: j.token_type,
  });

  const dl = new URL(String(deep_link));
  dl.searchParams.set("provider", "microsoft");
  dl.searchParams.set("status", "connected");
  res.redirect(dl.toString());
}
