import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin;
  admin.initializeApp();
  return admin;
}

export const firebaseAdmin = initAdmin();
export default firebaseAdmin;
