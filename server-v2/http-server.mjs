import http from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { ProjectService } from "./project-service.mjs";

const configuredOrigins = new Set(
  String(process.env.DUBROOM_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const adminApiToken = String(process.env.DUBROOM_ADMIN_API_TOKEN || "");

function allowedOrigin(origin) {
  if (!origin) return false;
  if (configuredOrigins.size === 0) {
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  }
  return configuredOrigins.has(origin);
}

function addCorsHeaders(baseHeaders, origin) {
  if (origin) {
    return {
      ...baseHeaders,
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
    };
  }
  return baseHeaders;
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const allowed = allowedOrigin(origin);
  const headers = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Take-Duration, X-Manifest-Revision",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    "Vary": "Origin",
  };
  return addCorsHeaders(headers, origin && allowed ? origin : "");
}

function json(request, response, status, body) {
  response.writeHead(status, {
    ...corsHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function metrics(response, service) {
  const runtime = service.runtimeStats?.() ?? {};
  const storage = service.storageStats?.() ?? {};
  const jobs = runtime.jobs ?? {};
  const queue = runtime.queue ?? {};
  const values = [
    ["dubroom_up", 1],
    ["dubroom_uptime_seconds", runtime.uptimeSeconds ?? 0],
    ["dubroom_queue_running", queue.running ?? 0],
    ["dubroom_queue_pending", queue.pending ?? 0],
    ["dubroom_job_pending", jobs.pending ?? 0],
    ["dubroom_job_running", jobs.running ?? 0],
    ["dubroom_job_retry_waiting", jobs.retryWaiting ?? 0],
    ["dubroom_job_dead_letter", jobs.deadLetter ?? 0],
    ["dubroom_job_oldest_pending_age_seconds", jobs.oldestPendingAgeSeconds ?? 0],
    ["dubroom_job_oldest_running_age_seconds", jobs.oldestRunningAgeSeconds ?? 0],
    ["dubroom_projects_failed", runtime.failedProjects ?? 0],
    ["dubroom_recommendations_failed", runtime.failedRecommendations ?? 0],
    ["dubroom_storage_bytes", storage.totalBytes ?? 0],
    ["dubroom_disk_free_bytes", storage.diskFreeBytes ?? 0],
  ];
  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${values.map(([name, value]) => `# TYPE ${name} gauge\n${name} ${Number(value) || 0}`).join("\n")}\n`);
}

async function readJson(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "");
  return match?.[1] || "";
}

function signedMediaAccess(url) {
  return {
    pathname: url.pathname,
    expires: url.searchParams.get("expires"),
    signature: url.searchParams.get("signature"),
  };
}

function adminAuthorized(request, expectedToken) {
  return Boolean(expectedToken) && request.headers["x-dubroom-admin-token"] === expectedToken;
}

function errorStatus(message) {
  if (message === "project_not_found") return 404;
  if (message === "project_unauthorized") return 401;
  if (message === "request_too_large") return 413;
  if (message === "source_duration_limit_exceeded" || message === "source_size_limit_exceeded" || message === "recommendation_poster_size_limit_exceeded") return 413;
  if (message === "project_limit_reached") return 429;
  if (message === "project_rate_limited") return 429;
  if (message === "storage_limit_reached" || message === "disk_space_low") return 507;
  if (message === "asset_not_found" || message === "cue_not_found" || message === "cache_not_found" || message === "recommendation_not_found" || message === "recommendation_asset_not_found" || message === "recommendation_category_not_found" || message === "job_not_found") return 404;
  if (message === "manifest_not_ready" || message === "project_not_recordable" || message === "project_not_ready_to_finalize" || message === "project_not_failed" || message === "job_not_failed" || message === "recommendation_not_failed" || message === "missing_takes" || message === "manifest_revision_mismatch" || message === "recommendation_category_name_conflict" || message === "recommendation_not_ready") return 409;
  if (message.startsWith("invalid_") || message.startsWith("rights_")) return 400;
  return 500;
}

function publicError(message, status) {
  return status >= 500 ? "server_error" : message;
}

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

async function readBytes(request, maximumBytes = 100 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeUpload(request, target, maximumBytes) {
  const output = createWriteStream(target, { flags: "wx" });
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error("request_too_large");
      if (!output.write(chunk)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            output.off("error", onError);
            resolve();
          };
          const onError = (error) => {
            output.off("drain", onDrain);
            reject(error);
          };
          output.once("drain", onDrain);
          output.once("error", onError);
        });
      }
    }
    output.end();
    await finished(output);
    return size;
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function sendFile(request, response, asset, { publicCache = false } = {}) {
  const range = request.headers.range;
  const headers = {
    ...corsHeaders(request),
    "Content-Type": asset.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": publicCache ? "public, max-age=3600" : "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": asset.stat.size });
    createReadStream(asset.filePath).pipe(response);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${asset.stat.size}` });
    response.end();
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), asset.stat.size - 1) : asset.stat.size - 1;
  if (start > end || start >= asset.stat.size) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${asset.stat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...headers,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${asset.stat.size}`,
  });
  createReadStream(asset.filePath, { start, end }).pipe(response);
}

export function createHttpServer({ service = new ProjectService(), adminToken = adminApiToken } = {}) {
  const creationAttempts = new Map();
  let lastRateLimitPruneAt = 0;
  const getHealthPayload = () => service.health
    ? service.health()
    : {
      status: "ready",
      service: "dubroom-server",
      version: "3.2",
      runtime: service.runtimeStats?.() ?? null,
      dependencies: service.dependencyStatus?.() ?? null,
    };
  return http.createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    const url = new URL(request.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && !allowedOrigin(requestOrigin)) {
        json(request, response, 403, { error: "origin_not_allowed" });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(request));
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const payload = getHealthPayload();
        json(request, response, 200, payload);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health/live") {
        json(request, response, 200, { status: "alive", service: "dubroom-server", version: "3.2" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health/ready") {
        const payload = getHealthPayload();
        json(request, response, payload.status === "ready" ? 200 : 503, payload);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/metrics") {
        metrics(response, service);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/recommendations") {
        json(request, response, 200, {
          recommendations: service.listRecommendations?.() ?? [],
          categories: service.listRecommendationCategories?.() ?? [],
        });
        return;
      }

      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "recommendations" && parts[2] && parts.length === 3) {
        json(request, response, 200, { recommendation: service.getRecommendation(parts[2]) });
        return;
      }

      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "recommendations" && parts[2] && parts[3]) {
        const kind = parts[3] === "poster" ? "poster" : parts[3] === "video" ? "video" : null;
        if (!kind) throw new Error("recommendation_asset_not_found");
        sendFile(request, response, service.recommendationAsset(parts[2], kind), { publicCache: true });
        return;
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "recommendations") {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, {
            recommendations: service.listAdminRecommendations(),
            categories: service.listRecommendationCategories?.() ?? [],
          });
          return;
        }
        if (request.method === "POST" && parts.length === 3) {
          if (String(request.headers["content-type"] || "").includes("application/json")) {
            const input = await readJson(request);
            const recommendation = service.createAdminRecommendationFromYouTube({
              title: input.title || "",
              sourceUrl: input.sourceUrl || "",
              categoryId: input.categoryId || null,
            });
            json(request, response, 202, { recommendation });
            return;
          }
          const maximumBytes = service.maximumRecommendationBytes?.() ?? 2 * 1024 * 1024 * 1024;
          const contentLength = Number(request.headers["content-length"] || 0);
          const upload = service.beginAdminRecommendation({
            title: url.searchParams.get("title") || "",
            originalName: url.searchParams.get("fileName") || "video.mp4",
            size: contentLength,
            categoryId: url.searchParams.get("categoryId") || null,
          });
          let size = 0;
          try {
            size = await writeUpload(request, upload.filePath, maximumBytes);
          } catch (error) {
            service.abortAdminRecommendation(upload.recommendation.id);
            throw error;
          }
          const recommendation = service.completeAdminRecommendation(upload.recommendation.id, size);
          json(request, response, 202, { recommendation });
          return;
        }
        if (request.method === "DELETE" && parts[3] && parts.length === 4) {
          service.removeAdminRecommendation(parts[3]);
          json(request, response, 200, { deleted: true });
          return;
        }
        if (request.method === "PUT" && parts[3] && parts[4] === "poster" && parts.length === 5) {
          const maximumBytes = service.maximumRecommendationPosterBytes?.() ?? 10 * 1024 * 1024;
          const recommendation = await service.updateAdminRecommendationPoster(parts[3], {
            originalName: url.searchParams.get("fileName") || "poster.jpg",
            bytes: await readBytes(request, maximumBytes),
          });
          json(request, response, 200, { recommendation });
          return;
        }
        if (request.method === "PUT" && parts[3] && parts.length === 4) {
          const input = await readJson(request);
          json(request, response, 200, { recommendation: service.setAdminRecommendationCategory(parts[3], { categoryId: input.categoryId || null }) });
          return;
        }
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "recommendation-categories") {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, { categories: service.listRecommendationCategories() });
          return;
        }
        if (request.method === "POST" && parts.length === 3) {
          const input = await readJson(request);
          json(request, response, 201, { category: service.createAdminRecommendationCategory({ name: input.name || "" }) });
          return;
        }
        if (request.method === "PUT" && parts[3] && parts.length === 4) {
          const input = await readJson(request);
          json(request, response, 200, { category: service.updateAdminRecommendationCategory(parts[3], { name: input.name || "" }) });
          return;
        }
        if (request.method === "DELETE" && parts[3] && parts.length === 4) {
          service.removeAdminRecommendationCategory(parts[3]);
          json(request, response, 200, { deleted: true });
          return;
        }
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "projects") {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, { projects: service.listAdminProjects() });
          return;
        }
        if (request.method === "DELETE" && parts[3] && parts.length === 4) {
          service.removeAdminProject(parts[3]);
          json(request, response, 200, { deleted: true });
          return;
        }
        if (request.method === "POST" && parts[3] && parts[4] === "retry" && parts.length === 5) {
          json(request, response, 202, { project: service.retryAdminProject(parts[3]) });
          return;
        }
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "jobs") {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, { jobs: service.listAdminDeadLetters?.() ?? [] });
          return;
        }
        if (request.method === "POST" && parts[3] && parts[4] === "retry" && parts.length === 5) {
          json(request, response, 202, service.retryAdminJob(parts[3]));
          return;
        }
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "cache") {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, { entries: service.listAdminCache() });
          return;
        }
        if (request.method === "DELETE" && parts.length === 3) {
          service.clearAdminCache();
          json(request, response, 200, { deleted: true });
          return;
        }
        if (request.method === "DELETE" && parts[3] && parts.length === 4) {
          service.removeAdminCache(parts[3]);
          json(request, response, 200, { deleted: true });
          return;
        }
      }

      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "settings" && parts.length === 3) {
        if (!adminAuthorized(request, adminToken)) {
          json(request, response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET") {
          json(request, response, 200, service.adminSettings());
          return;
        }
        if (request.method === "PUT") {
          json(request, response, 200, service.updateAdminSettings(await readJson(request)));
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/projects") {
        const now = Date.now();
        if (now - lastRateLimitPruneAt >= 60_000) {
          for (const [address, attempts] of creationAttempts) {
            const recent = attempts.filter((value) => now - value < 60_000);
            if (recent.length) creationAttempts.set(address, recent);
            else creationAttempts.delete(address);
          }
          lastRateLimitPruneAt = now;
        }
        const key = clientAddress(request);
        const current = (creationAttempts.get(key) || []).filter((value) => now - value < 60_000);
        const maximum = service.maximumProjectCreationsPerMinute?.() ?? 6;
        if (current.length >= maximum) throw new Error("project_rate_limited");
        current.push(now);
        creationAttempts.set(key, current);
        const input = await readJson(request);
        const result = input.recommendationId
          ? service.createFromRecommendation(input.recommendationId)
          : service.create(input);
        json(request, response, 202, result);
        return;
      }

      if (parts[0] === "v1" && parts[1] === "projects" && parts[2]) {
        const projectId = parts[2];
        const token = bearerToken(request);
        if (request.method === "GET" && parts.length === 3) {
          json(request, response, 200, { project: service.get(projectId, token) });
          return;
        }
        if (request.method === "GET" && parts[3] === "manifest") {
          json(request, response, 200, { manifest: service.manifest(projectId, token) });
          return;
        }
        if (request.method === "GET" && parts[3] === "events") {
          json(request, response, 200, { events: service.projectEvents(projectId, token) });
          return;
        }
        if (request.method === "GET" && parts[3] === "media" && parts[4]) {
          sendFile(request, response, service.asset(projectId, token, parts[4], signedMediaAccess(url)));
          return;
        }
        if (request.method === "PUT" && parts[3] === "takes" && parts[4]) {
          const bytes = await readBytes(request, service.maximumTakeBytes?.() ?? 100 * 1024 * 1024);
          const project = service.saveTake(projectId, token, decodeURIComponent(parts[4]), bytes, {
            duration: request.headers["x-take-duration"],
            revision: request.headers["x-manifest-revision"],
          });
          json(request, response, 200, { project });
          return;
        }
        if (request.method === "GET" && parts[3] === "takes" && parts[4]) {
          sendFile(request, response, service.takeAsset(projectId, token, decodeURIComponent(parts[4]), signedMediaAccess(url)));
          return;
        }
        if (request.method === "DELETE" && parts[3] === "takes" && parts[4]) {
          json(request, response, 200, { project: service.deleteTake(projectId, token, decodeURIComponent(parts[4])) });
          return;
        }
        if (request.method === "POST" && parts[3] === "finalize") {
          json(request, response, 202, { project: service.finalize(projectId, token) });
          return;
        }
        if (request.method === "GET" && parts[3] === "result") {
          if (parts[4] === "file") {
            sendFile(request, response, service.asset(projectId, token, "result", signedMediaAccess(url)));
          } else {
            json(request, response, 200, service.resultStatus(projectId, token));
          }
          return;
        }
        if (request.method === "POST" && parts[3] === "heartbeat") {
          json(request, response, 200, { project: service.heartbeat(projectId, token) });
          return;
        }
        if (request.method === "DELETE" && parts.length === 3) {
          service.remove(projectId, token);
          json(request, response, 200, { deleted: true });
          return;
        }
      }

      json(request, response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "server_error";
      const status = errorStatus(message);
      if (status >= 500) {
        console.error(JSON.stringify({
          level: "error",
          event: "http_request_failed",
          requestId,
          method: request.method,
          path: url.pathname,
          error: message,
        }));
      }
      json(request, response, status, { error: publicError(message, status), requestId });
    }
  });
}
