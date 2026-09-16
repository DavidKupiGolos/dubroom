import { adminUnauthorized, isAdminRequest } from "@/lib/admin-auth";

const projectApi = process.env.DUBROOM_INTERNAL_API || "http://127.0.0.1:5180";
const adminApiToken = process.env.DUBROOM_ADMIN_API_TOKEN || "";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    const response = await fetch(`${projectApi}/v1/admin/recommendations`, {
      headers: { "X-Dubroom-Admin-Token": adminApiToken },
      cache: "no-store",
    });
    return Response.json(await response.json(), { status: response.status });
  } catch {
    return Response.json({ error: "Сервер рекомендаций недоступен." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return adminUnauthorized();
  if (!adminApiToken) return Response.json({ error: "Служебный доступ к API не настроен." }, { status: 503 });
  try {
    if (String(request.headers.get("content-type") || "").includes("application/json")) {
      const input = await request.json() as { title?: string; sourceUrl?: string; categoryId?: string | null };
      const sourceUrl = String(input.sourceUrl || "").trim();
      if (!sourceUrl) return Response.json({ error: "Укажите ссылку на YouTube." }, { status: 400 });
      const response = await fetch(`${projectApi}/v1/admin/recommendations`, {
        method: "POST",
        headers: { "X-Dubroom-Admin-Token": adminApiToken, "Content-Type": "application/json" },
        body: JSON.stringify({ title: String(input.title || "").trim(), sourceUrl, categoryId: input.categoryId || null }),
        cache: "no-store",
      });
      return Response.json(await response.json(), { status: response.status });
    }
    const sourceUrl = new URL(request.url);
    const title = String(sourceUrl.searchParams.get("title") || "").trim();
    const fileName = String(sourceUrl.searchParams.get("fileName") || "video.mp4");
    const categoryId = String(sourceUrl.searchParams.get("categoryId") || "");
    if (!request.body) return Response.json({ error: "Выберите MP4-файл." }, { status: 400 });
    if (!title) return Response.json({ error: "Укажите название рекомендации." }, { status: 400 });
    const target = new URL("/v1/admin/recommendations", projectApi);
    target.searchParams.set("title", title);
    target.searchParams.set("fileName", fileName);
    if (categoryId) target.searchParams.set("categoryId", categoryId);
    const response = await fetch(target, {
      method: "POST",
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
    return Response.json({ error: "Не удалось загрузить рекомендацию." }, { status: 502 });
  }
}
