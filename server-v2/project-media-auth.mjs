import { createHmac, timingSafeEqual } from "node:crypto";

function signatureFor(project, pathname, expires) {
  return createHmac("sha256", project.token)
    .update(`${project.id}\n${pathname}\n${expires}`)
    .digest("base64url");
}

export function createSignedProjectUrl(project, pathname, { now = Date.now(), ttlSeconds = 3600 } = {}) {
  const ttl = Math.min(7200, Math.max(60, Math.floor(Number(ttlSeconds) || 3600)));
  const expires = Math.floor(now / 1000) + ttl;
  const signature = signatureFor(project, pathname, expires);
  return `${pathname}?expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

export function verifySignedProjectUrl(project, pathname, { expires, signature }, now = Date.now()) {
  const expiresAt = Number(expires);
  const provided = String(signature || "");
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(now / 1000) || !/^[a-zA-Z0-9_-]{43}$/.test(provided)) return false;
  const expected = signatureFor(project, pathname, expiresAt);
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}
