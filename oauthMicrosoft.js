export function registerMicrosoftOAuthRoutes(app) {
  app.get("/v1/oauth/microsoft/start", async (_req, res) => {
    res.status(501).json({ ok: false, error: "not_implemented" });
  });

  app.get("/v1/oauth/microsoft/callback", async (_req, res) => {
    res.status(501).json({ ok: false, error: "not_implemented" });
  });
}