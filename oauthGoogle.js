import { getGoogleOAuthClient } from "./providerClients.js";
import { setProviderTokens } from "./tokenStore.js";

function requireQuery(req, name) {
  const v = req.query?.[name];
  if (!v) throw new Error(`Missing query param: ${name}`);
  return String(v);
}

export function registerGoogleOAuthRoutes(app) {
  // Start: /v1/oauth/google/start?uid=...&deep_link=mindenu://oauth-callback
  app.get("/v1/oauth/google/start", async (req, res) => {
    try {
      const uid = requireQuery(req, "uid");
      const deepLink = requireQuery(req, "deep_link");

      const oauth2 = getGoogleOAuthClient();

      const scopesRaw =
        process.env.GOOGLE_SCOPES ||
        [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar",
        ].join(" ");

      const state = Buffer.from(
        JSON.stringify({ uid, deep_link: deepLink })
      ).toString("base64url");

      const url = oauth2.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: scopesRaw.split(/[,\s]+/).filter(Boolean),
        state,
      });

      return res.redirect(url);
    } catch (e) {
      return res
        .status(400)
        .send(`Google OAuth start error: ${String(e?.message || e)}`);
    }
  });

  // Callback must match your Google Cloud "Authorized redirect URIs"
  app.get("/v1/oauth/google/callback", async (req, res) => {
    try {
      const code = String(req.query?.code || "");
      const stateB64 = String(req.query?.state || "");
      if (!code) return res.status(400).send("Missing code");
      if (!stateB64) return res.status(400).send("Missing state");

      const state = JSON.parse(Buffer.from(stateB64, "base64url").toString("utf8"));
      const { uid, deep_link } = state;

      const oauth2 = getGoogleOAuthClient();
      const { tokens } = await oauth2.getToken(code);

      // Ensure refresh_token exists (prompt=consent helps)
      await setProviderTokens(uid, "google", {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date,
      });

      // Redirect back to iOS deep link
      const callback = `${deep_link}?provider=google&status=connected`;
      return res.redirect(callback);
    } catch (e) {
      return res
        .status(500)
        .send(`Google OAuth callback error: ${String(e?.message || e)}`);
    }
  });
}