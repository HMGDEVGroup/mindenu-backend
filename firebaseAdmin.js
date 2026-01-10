// firebaseAdmin.js
import admin from "firebase-admin";

/**
 * We load Firebase Admin using a Service Account JSON stored in env:
 *   FIREBASE_SERVICE_ACCOUNT_JSON = { ...full JSON... }
 *
 * This is required on Render (no Google metadata server).
 */

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw || !raw.trim()) {
    throw new Error(
      "[firebaseAdmin] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var. " +
        "Paste the entire service account JSON into Render Environment."
    );
  }

  // Render env var paste can sometimes include wrapping quotes, or be multi-line.
  const trimmed = raw.trim().replace(/^\uFEFF/, ""); // remove BOM if present

  let sa;
  try {
    sa = JSON.parse(trimmed);
  } catch (e1) {
    // Sometimes the JSON is accidentally wrapped in quotes or has escaped quotes.
    // Try a second-pass cleanup.
    try {
      const unwrapped = trimmed.replace(/^["']|["']$/g, "");
      sa = JSON.parse(unwrapped);
    } catch (e2) {
      throw new Error(
        "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. " +
          "Re-paste the full JSON exactly as downloaded from Firebase.\n" +
          `First parse error: ${String(e1)}\nSecond parse error: ${String(e2)}`
      );
    }
  }

  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is missing required fields. " +
        "Expected project_id, client_email, private_key."
    );
  }

  // Ensure private_key has real newlines (Firebase downloads include \n)
  // If the value already contains real newlines, this is harmless.
  sa.private_key = sa.private_key.replace(/\\n/g, "\n");

  return sa;
}

function initAdmin() {
  if (admin.apps.length) return admin;

  const sa = parseServiceAccountFromEnv();

  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  // Helpful boot logs (no secrets)
  console.log(
    `[firebaseAdmin] initialized with service account: ${sa.project_id}`
  );
  console.log(`[firebaseAdmin] client_email: ${sa.client_email}`);

  return admin;
}

export const firebaseAdmin = initAdmin();
export default firebaseAdmin;