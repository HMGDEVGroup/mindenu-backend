// tokenStore.js
import { firebaseAdmin } from "./firebaseAdmin.js";

const db = firebaseAdmin.firestore();

function tokensRef(uid, provider) {
  return db.collection("users").doc(uid).collection("tokens").doc(provider);
}

function pendingRef(uid) {
  return db.collection("users").doc(uid).collection("pending").doc("action");
}

export async function getUserProviderTokens(uid, provider) {
  const snap = await tokensRef(uid, provider).get();
  if (!snap.exists) throw new Error(`No tokens found for provider=${provider}`);
  return snap.data();
}

export async function setUserProviderTokens(uid, provider, tokens) {
  await tokensRef(uid, provider).set(tokens, { merge: true });
}

export async function getPendingAction(uid) {
  const snap = await pendingRef(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

export async function setPendingAction(uid, action) {
  await pendingRef(uid).set(action, { merge: true });
}

export async function clearPendingAction(uid) {
  await pendingRef(uid).delete().catch(() => {});
}
