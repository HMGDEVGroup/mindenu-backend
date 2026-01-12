import admin from "firebase-admin";

/**
 * Firebase Auth middleware for protecting backend routes.
 *
 * Expects:
 *   Authorization: Bearer <Firebase ID Token>
 *
 * Attaches:
 *   req.user = decoded token (includes uid)
 *
 * Exports:
 *   - requireAuth (named)
 *   - default requireAuth
 */

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer (.+)$/);

    if (!match) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
        details: "Missing Authorization: Bearer <token>",
      });
    }

    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.user = decoded; // decoded.uid is the Firebase UID
    return next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      details: err?.message || String(err),
    });
  }
}

export default requireAuth;
