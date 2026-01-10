// firebaseAdmin.js
import admin from "firebase-admin";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Missing FIREBASE_SERVICE_ACCOUNT_JSON in environment. Add it in Render -> Environment."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Re-paste the ENTIRE JSON exactly as downloaded."
    );
  }

  // Important: Render sometimes stores actual newlines; Firebase expects \n inside private_key
  if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("[firebaseAdmin] initialized with service account:", serviceAccount.project_id);
}

export default admin;
