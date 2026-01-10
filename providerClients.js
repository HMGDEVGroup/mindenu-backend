// providerClients.js (ESM)
import { google } from "googleapis";
import firebaseAdmin from "./firebaseAdmin.js";

const db = firebaseAdmin.firestore();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`[env] Missing ${name}`);
  return v;
}

// Google OAuth env vars (Render)
const GOOGLE_OAUTH_CLIENT_ID = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_OAUTH_REDIRECT_URI = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");

// Store tokens here:
// users/{uid}/providers/google
function googleTokenDocRef(uid) {
  return db.collection("users").doc(uid).collection("providers").doc("google");
}

export async function verifyFirebaseBearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    const err = new Error("missing_authorization");
    err.status = 401;
    throw err;
  }

  const idToken = m[1];
  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    return { uid: decoded.uid, decoded, idToken };
  } catch (e) {
    const err = new Error("invalid_id_token");
    err.status = 401;
    err.details = e?.message || String(e);
    throw err;
  }
}

export async function getGoogleTokens(uid) {
  const snap = await googleTokenDocRef(uid).get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

export async function saveGoogleTokens(uid, tokens) {
  // tokens = { access_token, refresh_token, scope, token_type, expiry_date }
  await googleTokenDocRef(uid).set(
    {
      ...tokens,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export function buildGoogleOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI
  );
}

export async function getGoogleCalendarClientForUid(uid) {
  const tokens = await getGoogleTokens(uid);
  if (!tokens) return null;

  const oauth2 = buildGoogleOAuthClient();
  oauth2.setCredentials(tokens);

  // If token expired but refresh_token exists, googleapis will auto-refresh.
  // We should listen and persist refreshed tokens.
  oauth2.on("tokens", async (newTokens) => {
    if (!newTokens) return;
    // Merge with existing to retain refresh_token if not included every time
    await saveGoogleTokens(uid, { ...tokens, ...newTokens });
  });

  return google.calendar({ version: "v3", auth: oauth2 });
}