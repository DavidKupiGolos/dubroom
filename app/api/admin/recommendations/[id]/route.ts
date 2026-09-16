import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  const { id } = await context.params;
  try {
    const input = await request.json() as { categoryId?: string | null };
    const response = await fetch(`${projectApi}/v1/admin/recommendations/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "X-Dubroom-Admin-Token": adminApiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: input.categoryId || null }),
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Не удалось изменить категорию рекомендации." }, { status: 502 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  const { id } = await context.params;
  try {
    const response = await fetch(`${projectApi}/v1/admin/recommendations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Dubroom-Admin-Token": adminApiToken },
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Сервер рекомендаций недоступен." }, { status: 502 });
  }
}
