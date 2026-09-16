import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

async function proxy(request: Request, context: { params: Promise<{ id: string }> }, method: "PUT" | "DELETE") {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  const { id } = await context.params;
  try {
    const response = await fetch(`${projectApi}/v1/admin/recommendation-categories/${encodeURIComponent(id)}`, {
      method,
      headers: {
        "X-Dubroom-Admin-Token": adminApiToken,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "PUT" ? JSON.stringify(await request.json()) : undefined,
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Не удалось изменить категорию." }, { status: 502 });
  }
}

export function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context, "PUT");
}

export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return proxy(request, context, "DELETE");
}
