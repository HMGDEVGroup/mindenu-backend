import { firebaseAdmin } from "./firebaseAdmin.js";

/**
 * Verifies Firebase ID tokens (Bearer) and sets req.user = { uid, email? }.
 * Docs: https://firebase.google.com/docs/auth/admin/verify-id-tokens
 */
export async function requireFirebaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: "missing_auth" });

    const idToken = match[1];
    const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_auth", details: String(err?.message || err) });
  }
}
