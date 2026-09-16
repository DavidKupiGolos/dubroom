import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    const response = await fetch(`${projectApi}/v1/admin/recommendation-categories`, {
      headers: { "X-Dubroom-Admin-Token": adminApiToken },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Сервер категорий недоступен." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    const input = await request.json() as { name?: string };
    const response = await fetch(`${projectApi}/v1/admin/recommendation-categories`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": adminApiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ name: String(input.name || "").trim() }),
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Не удалось создать категорию." }, { status: 502 });
  }
}
