// firebaseAdmin.js (ESM)
import admin from "firebase-admin";

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw || !raw.trim()) {
    throw new Error(
      "[firebaseAdmin] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var. Paste the entire service account JSON into Render Environment."
    );
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Error: ${e?.message || e}`
    );
  }

  // Handle cases where private_key newlines were escaped
  if (typeof obj.private_key === "string") {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }

  if (!obj.client_email || !obj.private_key || !obj.project_id) {
    throw new Error(
      "[firebaseAdmin] Service account JSON missing required fields (client_email/private_key/project_id)."
    );
  }

  return obj;
}

function initAdmin() {
  if (admin.apps.length) return admin;

  const serviceAccount = parseServiceAccountFromEnv();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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