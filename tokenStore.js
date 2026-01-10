import firebaseAdmin from "./firebaseAdmin.js";

const db = firebaseAdmin.firestore();

function docRef(uid, provider) {
  return db.collection("oauth_tokens").doc(`${uid}__${provider}`);
}

export async function saveTokens({ uid, provider, tokens, meta = {} }) {
  if (!uid) throw new Error("saveTokens: missing uid");
  if (!provider) throw new Error("saveTokens: missing provider");

  await docRef(uid, provider).set(
    {
      uid,
      provider,
      tokens,
      meta,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export async function getTokens({ uid, provider }) {
  const snap = await docRef(uid, provider).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data?.tokens || null;
}

export async function deleteTokens({ uid, provider }) {
  await docRef(uid, provider).delete();
}