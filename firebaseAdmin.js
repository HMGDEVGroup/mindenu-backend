import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT_JSON is missing");
    admin.initializeApp(); // fallback (won't work on Render unless running on GCP)
    return admin;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the entire service account JSON file contents."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

export const firebaseAdmin = initAdmin();
export default firebaseAdmin;