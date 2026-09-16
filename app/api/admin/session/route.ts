import { adminSessionCookie, clearAdminSessionCookie, isAdminAuthConfigured, isAdminPassword, isAdminRequest } from "@/lib/admin-auth";

const loginAttempts = new Map<string, number[]>();

function clientAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
}

export async function GET(request: Request) {
  return Response.json({ authenticated: isAdminRequest(request) });
}

export async function POST(request: Request) {
  if (!isAdminAuthConfigured()) {
    return Response.json({ error: "Доступ к админ-панели не настроен на сервере." }, { status: 503 });
  }
  const now = Date.now();
  const address = clientAddress(request);
  const attempts = (loginAttempts.get(address) ?? []).filter((value) => now - value < 10 * 60 * 1000);
  if (attempts.length >= 5) return Response.json({ error: "Слишком много попыток. Повторите вход через 10 минут." }, { status: 429 });
  const input = await request.json().catch(() => null) as { password?: string } | null;
  if (!isAdminPassword(String(input?.password ?? ""))) {
    attempts.push(now);
    loginAttempts.set(address, attempts);
    return Response.json({ error: "Неверный пароль." }, { status: 401 });
  }
  loginAttempts.delete(address);
  return Response.json({ authenticated: true }, { headers: { "Set-Cookie": adminSessionCookie(request) } });
}

export async function DELETE(request: Request) {
  return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearAdminSessionCookie(request) } });
}
