import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

async function proxy(request: Request, method: "GET" | "PUT") {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    const response = await fetch(`${projectApi}/v1/admin/settings`, {
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
    return Response.json({ error: "Сервер настроек недоступен." }, { status: 502 });
  }
}

export function GET(request: Request) {
  return proxy(request, "GET");
}

export function PUT(request: Request) {
  return proxy(request, "PUT");
}
