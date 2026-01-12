import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const creds = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
    return admin;
  }

  // Falls back to GOOGLE_APPLICATION_CREDENTIALS env var if set
  admin.initializeApp();
  return admin;
}

export const firebaseAdmin = initAdmin();
