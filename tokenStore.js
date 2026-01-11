/**
 * In-memory token store (starter only).
 * Replace with DB + encryption-at-rest.
 *
 * Keyed by: uid + provider.
 */
const store = new Map();

export function setProviderTokens(uid, provider, tokens) {
  const key = `${uid}:${provider}`;
  store.set(key, { ...tokens, updatedAt: Date.now() });
}

export function getProviderTokens(uid, provider) {
  const key = `${uid}:${provider}`;
  return store.get(key) || null;
}

export function clearProviderTokens(uid, provider) {
  const key = `${uid}:${provider}`;
  store.delete(key);
}
