// backend-node/providerClients.js
import { google } from "googleapis";
import firebaseAdmin from "./firebaseAdmin.js";

const db = firebaseAdmin.firestore();

/**
 * REQUIRED env vars in Render:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI   (must match what’s in Google Cloud console)
 *
 * Optional:
 *   APP_OAUTH_SUCCESS_REDIRECT  (where to send user after Google callback)
 *     Example for iOS custom scheme:
 *       mindenu://oauth/google?ok=1
 *     Or a web page:
 *       https://your-site.com/oauth/success
 */

export function makeGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "[google] Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI in environment"
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Save provider tokens in Firestore
 * Path:
 *   users/{uid}/providers/google
 */
export async function saveGoogleTokensForUid(uid, tokens) {
  await db
    .collection("users")
    .doc(uid)
    .collection("providers")
    .doc("google")
    .set(
      {
        tokens,
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

export async function getGoogleTokensForUid(uid) {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("providers")
    .doc("google")
    .get();

  if (!snap.exists) return null;
  const data = snap.data();
  return data?.tokens || null;
}

/**
 * Create an authenticated Google client from stored tokens.
 */
export async function getAuthedGoogleClientForUid(uid) {
  const tokens = await getGoogleTokensForUid(uid);
  if (!tokens) return null;

  const oauth2 = makeGoogleOAuthClient();
  oauth2.setCredentials(tokens);

  return oauth2;
}

/**
 * Short-lived "state" storage so callback can map back to uid.
 * Path:
 *   oauthStates/{state}
 */
export async function createOAuthState(uid, state) {
  await db.collection("oauthStates").doc(state).set({
    uid,
    createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function consumeOAuthState(state) {
  const ref = db.collection("oauthStates").doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const { uid } = snap.data() || {};
  await ref.delete();
  return uid || null;
}