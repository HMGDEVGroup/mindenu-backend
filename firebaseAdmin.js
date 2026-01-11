// backend-node/firebaseAdmin.js
import admin from "firebase-admin";

/**
 * Render env var required:
 *   FIREBASE_SERVICE_ACCOUNT_JSON = { ...entire service account json... }
 *
 * Optional (if you want to hard-force project id):
 *   FIREBASE_PROJECT_ID = mindenu-7d3ba
 */

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "[firebaseAdmin] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var. Paste the entire service account JSON into Render Environment."
    );
  }

  try {
    // Render sometimes escapes newlines; normalize private_key
    const obj = JSON.parse(raw);
    if (obj.private_key && typeof obj.private_key === "string") {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    return obj;
  } catch (e) {
    throw new Error(
      `[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e?.message || e}`
    );
  }
}

function initAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccount = parseServiceAccountFromEnv();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });

  console.log(
    "[firebaseAdmin] initialized with service account:",
    serviceAccount.project_id
  );
  console.log("[firebaseAdmin] client_email:", serviceAccount.client_email);

  return admin;
}

export const firebaseAdmin = initAdmin();
export default firebaseAdmin;