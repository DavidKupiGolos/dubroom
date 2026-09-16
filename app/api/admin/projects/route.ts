import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    const response = await fetch(`${projectApi}/v1/admin/projects`, {
      headers: { "X-Dubroom-Admin-Token": adminApiToken },
      cache: "no-store",
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status });
  } catch {
    return Response.json({ error: "Сервер проектов недоступен." }, { status: 502 });
  }
}
