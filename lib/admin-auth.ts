const cookieName = "dubroom_admin";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
const sessionToken = process.env.ADMIN_SESSION_TOKEN ?? "";

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function readCookie(request: Request, name: string) {
  const source = request.headers.get("cookie") ?? "";
  for (const item of source.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function isAdminRequest(request: Request) {
  return Boolean(sessionToken) && constantTimeEqual(readCookie(request, cookieName) ?? "", sessionToken);
}

export function isAdminPassword(password: string) {
  return Boolean(adminPassword) && constantTimeEqual(password, adminPassword);
}

export function isAdminAuthConfigured() {
  return Boolean(adminPassword && sessionToken);
}

export function adminSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`;
}

export function clearAdminSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function adminUnauthorized() {
  return Response.json({ error: "Требуется вход в админ-панель." }, { status: 401 });
}
