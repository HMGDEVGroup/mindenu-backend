import firebaseAdmin from "./firebaseAdmin.js";

const db = firebaseAdmin.firestore();

function userDoc(uid) {
  if (!uid) throw new Error("Missing uid");
  return db.collection("users").doc(uid);
}

export async function getUser(uid) {
  const snap = await userDoc(uid).get();
  return snap.exists ? snap.data() : null;
}

export async function setUser(uid, data) {
  await userDoc(uid).set(data, { merge: true });
}

export async function getProviderTokens(uid, provider) {
  const user = await getUser(uid);
  if (!user) return null;
  return user?.tokens?.[provider] || null;
}

export async function setProviderTokens(uid, provider, tokens) {
  await setUser(uid, {
    tokens: {
      [provider]: tokens,
    },
    updatedAt: Date.now(),
  });
}

export async function clearProviderTokens(uid, provider) {
  const user = await getUser(uid);
  const tokens = user?.tokens || {};
  delete tokens[provider];
  await setUser(uid, { tokens, updatedAt: Date.now() });
}

export async function setPendingAction(uid, pending) {
  await setUser(uid, {
    pendingAction: pending || null,
    pendingUpdatedAt: Date.now(),
  });
}

export async function getPendingAction(uid) {
  const user = await getUser(uid);
  return user?.pendingAction || null;
}

export async function clearPendingAction(uid) {
  await setPendingAction(uid, null);
}