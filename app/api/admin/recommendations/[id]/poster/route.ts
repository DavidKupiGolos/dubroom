import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  const { id } = await context.params;
  try {
    if (!request.body) return Response.json({ error: "Выберите изображение превью." }, { status: 400 });
    const fileName = new URL(request.url).searchParams.get("fileName") || "poster.jpg";
    const target = new URL(`/v1/admin/recommendations/${encodeURIComponent(id)}/poster`, projectApi);
    target.searchParams.set("fileName", fileName);
    const response = await fetch(target, {
      method: "PUT",
      headers: {
        "X-Dubroom-Admin-Token": adminApiToken,
        "Content-Type": "application/octet-stream",
      },
      body: request.body,
      cache: "no-store",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Не удалось обновить превью рекомендации." }, { status: 502 });
  }
}
