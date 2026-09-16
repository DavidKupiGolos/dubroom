import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  const { id } = await context.params;
  try {
    const response = await fetch(`${projectApi}/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": adminApiToken },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Сервер заданий недоступен." }, { status: 502 });
  }
}
