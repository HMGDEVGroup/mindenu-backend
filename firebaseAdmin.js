import admin from "firebase-admin";

function initFirebaseAdmin() {
  if (admin.apps?.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn(
      "[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is missing. Firebase features will fail."
    );
    admin.initializeApp();
    return admin;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the ENTIRE service account JSON as a single env var."
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log(
    `[firebaseAdmin] initialized with service account: ${serviceAccount.project_id || "unknown"}`
  );

  return admin;
}

export const firebaseAdmin = initFirebaseAdmin();
export default firebaseAdmin;