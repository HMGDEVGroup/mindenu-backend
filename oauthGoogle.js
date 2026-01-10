import { google } from "googleapis";
import { saveTokens } from "./tokenStore.js";

function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing GOOGLE OAuth env vars. Need GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI."
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function googleStartURL({ uid, deep_link }) {
  if (!uid || !deep_link) {
    const err = new Error("Missing uid or deep_link");
    err.status = 400;
    throw err;
  }

  const oauth2Client = getGoogleOAuthClient();
  const scopes = (process.env.GOOGLE_SCOPES || "")
    .split(/\s+/)
    .filter(Boolean);

  if (!scopes.length) {
    const err = new Error(
      "GOOGLE_SCOPES env var missing/empty. Provide space-separated scopes."
    );
    err.status = 500;
    throw err;
  }

  const state = Buffer.from(
    JSON.stringify({ uid, deep_link, provider: "google" }),
    "utf8"
  ).toString("base64url");

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    include_granted_scopes: true,
    state,
  });
}

export async function googleHandleCallback({ code, state }) {
  if (!code) {
    const err = new Error("Missing code");
    err.status = 400;
    throw err;
  }
  if (!state) {
    const err = new Error("Missing state");
    err.status = 400;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    const err = new Error("Invalid state");
    err.status = 400;
    throw err;
  }

  const { uid, deep_link } = parsed;
  if (!uid || !deep_link) {
    const err = new Error("Invalid state payload (missing uid/deep_link)");
    err.status = 400;
    throw err;
  }

  const oauth2Client = getGoogleOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  await saveTokens({
    uid,
    provider: "google",
    tokens,
    meta: { connected: true },
  });

  return { uid, deep_link };
}

export function googleOAuthClientFromTokens(tokens) {
  const oauth2Client = getGoogleOAuthClient();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}