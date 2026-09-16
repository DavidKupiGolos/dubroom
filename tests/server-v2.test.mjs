import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCues } from "../server-v2/cues.mjs";
import { workingRetentionMs } from "../server-v2/domain.mjs";
import { defaultServerSettings } from "../server-v2/local-settings.mjs";
import { createHttpServer } from "../server-v2/http-server.mjs";
import { parsePublicYouTubeUrl } from "../server-v2/youtube.mjs";
import { createSignedProjectUrl, verifySignedProjectUrl } from "../server-v2/project-media-auth.mjs";

test("project media signatures are scoped to path and expiry", () => {
  const project = { id: "00000000-0000-4000-8000-000000000001", token: "private-project-token" };
  const pathname = `/v1/projects/${project.id}/media/prepared`;
  const signedUrl = createSignedProjectUrl(project, pathname, { now: 1_000_000, ttlSeconds: 60 });
  const parsed = new URL(signedUrl, "http://localhost");
  const signed = {
    expires: parsed.searchParams.get("expires"),
    signature: parsed.searchParams.get("signature"),
  };

  assert.equal(parsed.searchParams.has("token"), false);
  assert.equal(verifySignedProjectUrl(project, pathname, signed, 1_059_000), true);
  assert.equal(verifySignedProjectUrl(project, `${pathname}-tampered`, signed, 1_059_000), false);
  assert.equal(verifySignedProjectUrl(project, pathname, signed, 1_061_000), false);
});

test("accepts supported public YouTube URL shapes and canonicalizes them", () => {
  const id = "dQw4w9WgXcQ";
  for (const value of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://m.youtube.com/live/${id}`,
  ]) {
    assert.deepEqual(parsePublicYouTubeUrl(value), {
      videoId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    });
  }
  assert.throws(() => parsePublicYouTubeUrl("http://youtube.com/watch?v=dQw4w9WgXcQ"), /invalid_youtube_url/);
  assert.throws(() => parsePublicYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ"), /invalid_youtube_url/);
});

test("builds one chronological cue stream without speaker roles", () => {
  const cues = buildCues([
    { type: "word", text: "Первая", start: 0.1, end: 0.4, speaker_id: "speaker_1" },
    { type: "word", text: "фраза.", start: 0.42, end: 0.8, speaker_id: "speaker_1" },
    { type: "word", text: "Вторая", start: 1.6, end: 1.9, speaker_id: "speaker_2" },
    { type: "word", text: "фраза!", start: 1.92, end: 2.3, speaker_id: "speaker_2" },
  ]);
  assert.deepEqual(cues, [
    { id: "cue-0001", start: 0.1, end: 0.8, text: "Первая фраза." },
    { id: "cue-0002", start: 1.6, end: 2.3, text: "Вторая фраза!" },
  ]);
  assert.equal("speakerId" in cues[0], false);
});

test("uses the agreed retention windows", () => {
  assert.equal(workingRetentionMs, 60 * 60 * 1000);
  assert.equal(defaultServerSettings.projectRetentionMinutes, 60);
  assert.equal(defaultServerSettings.cacheRetentionHours, 72);
});

test("project API requires rights confirmation and project authorization", async () => {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const missingRights = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ" }),
    });
    assert.equal(missingRights.status, 400);
    assert.equal((await missingRights.json()).error, "rights_confirmation_required");

    const created = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true }),
    });
    assert.equal(created.status, 202);
    const payload = await created.json();
    assert.match(payload.project.id, /^[0-9a-f-]{36}$/i);
    assert.ok(payload.token.length >= 40);

    const unauthorized = await fetch(`${baseUrl}/v1/projects/${payload.project.id}`);
    assert.equal(unauthorized.status, 401);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const loaded = await fetch(`${baseUrl}/v1/projects/${payload.project.id}`, {
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    assert.equal(loaded.status, 200);
    const loadedProject = (await loaded.json()).project;
    assert.equal(loadedProject.state, "READY_TO_DUB");
    assert.equal(loadedProject.cues.length, 2);

    const heartbeat = await fetch(`${baseUrl}/v1/projects/${payload.project.id}/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    assert.equal(heartbeat.status, 200);

    const removed = await fetch(`${baseUrl}/v1/projects/${payload.project.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${payload.token}` },
    });
    assert.equal(removed.status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("admin project API requires its service token and can list and delete projects", async () => {
  const uploadRoot = mkdtempSync(path.join(tmpdir(), "dubroom-admin-upload-"));
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  let settings = { projectRetentionMinutes: 60 };
  service.adminSettings = () => ({ settings, limits: {}, storage: { totalBytes: 0 } });
  service.updateAdminSettings = (input) => {
    settings = { ...settings, ...input };
    return service.adminSettings();
  };
  service.listAdminCache = () => [{ videoId: "dQw4w9WgXcQ", title: "Cached", bytes: 10 }];
  service.removeAdminCache = () => undefined;
  service.clearAdminCache = () => undefined;
  let deadLetters = [{ id: "job-id", ownerType: "project", ownerId: "owner-id", ownerTitle: "Failed video", stage: "prepare_video", attempts: 3, failedAt: 1, error: "process_timeout" }];
  service.listAdminDeadLetters = () => deadLetters;
  service.retryAdminJob = (id) => {
    deadLetters = deadLetters.filter((job) => job.id !== id);
    return { jobId: id, ownerType: "project", project: { id: "owner-id", state: "CREATED" } };
  };
  let recommendations = [];
  let recommendationCategories = [];
  service.listRecommendations = () => recommendations.filter((item) => item.state === "READY");
  service.listRecommendationCategories = () => recommendationCategories;
  service.createAdminRecommendationCategory = ({ name }) => {
    const category = { id: "00000000-0000-4000-8000-000000000010", name, createdAt: 1, updatedAt: 1 };
    recommendationCategories = [category];
    return category;
  };
  service.updateAdminRecommendationCategory = (id, { name }) => {
    recommendationCategories = recommendationCategories.map((item) => item.id === id ? { ...item, name, updatedAt: 2 } : item);
    return recommendationCategories.find((item) => item.id === id);
  };
  service.removeAdminRecommendationCategory = (id) => {
    recommendationCategories = recommendationCategories.filter((item) => item.id !== id);
    recommendations = recommendations.map((item) => item.categoryId === id ? { ...item, categoryId: null } : item);
  };
  service.getRecommendation = (id) => ({ id, title: "Публичная рекомендация", state: "READY", shareUrl: `/?recommendation=${id}`, videoUrl: `/v1/recommendations/${id}/video` });
  service.listAdminRecommendations = () => recommendations;
  service.maximumRecommendationBytes = () => 1024;
  service.maximumRecommendationPosterBytes = () => 1024;
  service.beginAdminRecommendation = ({ title, categoryId }) => {
    const recommendation = { id: "00000000-0000-4000-8000-000000000001", title, categoryId, state: "PROCESSING", progress: 5, bytes: 0 };
    recommendations = [recommendation];
    return { recommendation, filePath: path.join(uploadRoot, "upload.mp4") };
  };
  service.completeAdminRecommendation = (id, size) => {
    recommendations = recommendations.map((item) => item.id === id ? { ...item, bytes: size } : item);
    return recommendations[0];
  };
  service.createAdminRecommendationFromYouTube = ({ title, sourceUrl, categoryId }) => {
    const recommendation = { id: "00000000-0000-4000-8000-000000000002", title: title || "Название из YouTube", sourceUrl, categoryId, sourceType: "youtube", state: "PROCESSING", progress: 5, bytes: 0 };
    recommendations = [recommendation, ...recommendations];
    return recommendation;
  };
  service.createFromRecommendation = (recommendationId) => ({
    project: { id: "00000000-0000-4000-8000-000000000003", state: "CREATED", progress: 0, sourceUrl: `/recommendations/${recommendationId}` },
    token: "recommendation-project-token-000000000000000000000000",
  });
  service.abortAdminRecommendation = () => { recommendations = []; };
  service.removeAdminRecommendation = (id) => { recommendations = recommendations.filter((item) => item.id !== id); };
  service.setAdminRecommendationCategory = (id, { categoryId }) => {
    recommendations = recommendations.map((item) => item.id === id ? { ...item, categoryId } : item);
    return recommendations.find((item) => item.id === id);
  };
  service.updateAdminRecommendationPoster = async (id) => {
    recommendations = recommendations.map((item) => item.id === id ? { ...item, posterUrl: `/v1/recommendations/${id}/poster?v=2` } : item);
    return recommendations.find((item) => item.id === id);
  };
  const created = service.create({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/admin/projects`);
    assert.equal(unauthorized.status, 401);

    const listed = await fetch(`${baseUrl}/v1/admin/projects`, {
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(listed.status, 200);
    const projects = (await listed.json()).projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, created.project.id);
    assert.equal("token" in projects[0], false);

    const jobsResponse = await fetch(`${baseUrl}/v1/admin/jobs`, {
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(jobsResponse.status, 200);
    assert.equal((await jobsResponse.json()).jobs[0].stage, "prepare_video");
    const retryJobResponse = await fetch(`${baseUrl}/v1/admin/jobs/job-id/retry`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(retryJobResponse.status, 202);
    assert.equal((await retryJobResponse.json()).jobId, "job-id");

    const removed = await fetch(`${baseUrl}/v1/admin/projects/${created.project.id}`, {
      method: "DELETE",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { deleted: true });
    assert.equal(service.listAdminProjects().length, 0);

    const settingsResponse = await fetch(`${baseUrl}/v1/admin/settings`, {
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(settingsResponse.status, 200);
    assert.equal((await settingsResponse.json()).settings.projectRetentionMinutes, 60);

    const updatedSettings = await fetch(`${baseUrl}/v1/admin/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Dubroom-Admin-Token": "test-admin-token" },
      body: JSON.stringify({ projectRetentionMinutes: 75 }),
    });
    assert.equal(updatedSettings.status, 200);
    assert.equal((await updatedSettings.json()).settings.projectRetentionMinutes, 75);

    const cached = await fetch(`${baseUrl}/v1/admin/cache`, {
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).entries[0].videoId, "dQw4w9WgXcQ");
    const removedCache = await fetch(`${baseUrl}/v1/admin/cache/dQw4w9WgXcQ`, {
      method: "DELETE",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(removedCache.status, 200);

    const unauthorizedRecommendation = await fetch(`${baseUrl}/v1/admin/recommendations`, { method: "POST", body: new Uint8Array([1]) });
    assert.equal(unauthorizedRecommendation.status, 401);
    const unauthorizedPoster = await fetch(`${baseUrl}/v1/admin/recommendations/00000000-0000-4000-8000-000000000001/poster?fileName=preview.png`, { method: "PUT", body: new Uint8Array([1]) });
    assert.equal(unauthorizedPoster.status, 401);
    const unauthorizedCategory = await fetch(`${baseUrl}/v1/admin/recommendation-categories`);
    assert.equal(unauthorizedCategory.status, 401);
    const createdCategoryResponse = await fetch(`${baseUrl}/v1/admin/recommendation-categories`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Комедия" }),
    });
    assert.equal(createdCategoryResponse.status, 201);
    const category = (await createdCategoryResponse.json()).category;
    assert.equal(category.name, "Комедия");
    const renamedCategoryResponse = await fetch(`${baseUrl}/v1/admin/recommendation-categories/${category.id}`, {
      method: "PUT",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Юмор" }),
    });
    assert.equal((await renamedCategoryResponse.json()).category.name, "Юмор");
    const uploadedRecommendation = await fetch(`${baseUrl}/v1/admin/recommendations?title=${encodeURIComponent("Рекомендация")}&fileName=clip.mp4&categoryId=${category.id}`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(uploadedRecommendation.status, 202);
    const uploadedRecommendationPayload = await uploadedRecommendation.json();
    assert.equal(uploadedRecommendationPayload.recommendation.title, "Рекомендация");
    assert.equal(uploadedRecommendationPayload.recommendation.categoryId, category.id);
    const linkedRecommendation = await fetch(`${baseUrl}/v1/admin/recommendations`, {
      method: "POST",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", categoryId: category.id }),
    });
    assert.equal(linkedRecommendation.status, 202);
    assert.equal((await linkedRecommendation.json()).recommendation.sourceType, "youtube");
    const adminRecommendations = await fetch(`${baseUrl}/v1/admin/recommendations`, { headers: { "X-Dubroom-Admin-Token": "test-admin-token" } });
    const adminRecommendationPayload = await adminRecommendations.json();
    assert.equal(adminRecommendationPayload.recommendations.length, 2);
    assert.equal(adminRecommendationPayload.categories[0].name, "Юмор");
    const reassignedRecommendation = await fetch(`${baseUrl}/v1/admin/recommendations/00000000-0000-4000-8000-000000000001`, {
      method: "PUT",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: null }),
    });
    assert.equal((await reassignedRecommendation.json()).recommendation.categoryId, null);
    const updatedPoster = await fetch(`${baseUrl}/v1/admin/recommendations/00000000-0000-4000-8000-000000000001/poster?fileName=preview.png`, {
      method: "PUT",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token", "Content-Type": "application/octet-stream" },
      body: new Uint8Array([4, 5, 6]),
    });
    assert.equal(updatedPoster.status, 200);
    assert.match((await updatedPoster.json()).recommendation.posterUrl, /poster\?v=2/);
    const publicRecommendations = await fetch(`${baseUrl}/v1/recommendations`);
    const publicRecommendationPayload = await publicRecommendations.json();
    assert.equal(publicRecommendationPayload.recommendations.length, 0);
    assert.equal(publicRecommendationPayload.categories[0].name, "Юмор");
    const publicRecommendation = await fetch(`${baseUrl}/v1/recommendations/00000000-0000-4000-8000-000000000002`);
    assert.equal(publicRecommendation.status, 200);
    assert.equal((await publicRecommendation.json()).recommendation.title, "Публичная рекомендация");
    const selectedRecommendation = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recommendationId: "00000000-0000-4000-8000-000000000002" }),
    });
    assert.equal(selectedRecommendation.status, 202);
    assert.match((await selectedRecommendation.json()).project.sourceUrl, /\/recommendations\//);
    const removedRecommendation = await fetch(`${baseUrl}/v1/admin/recommendations/00000000-0000-4000-8000-000000000001`, {
      method: "DELETE",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(removedRecommendation.status, 200);
    const removedCategory = await fetch(`${baseUrl}/v1/admin/recommendation-categories/${category.id}`, {
      method: "DELETE",
      headers: { "X-Dubroom-Admin-Token": "test-admin-token" },
    });
    assert.equal(removedCategory.status, 200);
    assert.deepEqual(await removedCategory.json(), { deleted: true });
  } finally {
    server.close();
    await once(server, "close");
    rmSync(uploadRoot, { recursive: true, force: true });
  }
});

test("rate limits project creation by client address", async () => {
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  service.maximumProjectCreationsPerMinute = () => 1;
  const server = createHttpServer({ service });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const create = () => fetch(`${baseUrl}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.10" },
    body: JSON.stringify({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true }),
  });
  try {
    assert.equal((await create()).status, 202);
    const limited = await create();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, "project_rate_limited");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("returns invalid_json for malformed JSON", async () => {
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ bad json ",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_json");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("returns forbidden for untrusted Origin", async () => {
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/health`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "origin_not_allowed");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("health endpoint returns runtime and dependency diagnostics", async () => {
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  service.runtimeStats = () => ({
    status: "attention",
    queue: { concurrency: 1, running: 0, pending: 1 },
    jobs: { pending: 1, running: 0, retryWaiting: 0, deadLetter: 2, oldestPendingAgeSeconds: 12, oldestRunningAgeSeconds: 0 },
    pipelineMode: "stub",
    failedProjects: 2,
    failedRecommendations: 0,
  });
  service.storageStats = () => ({ totalBytes: 1024, diskFreeBytes: 2048 });
  service.dependencyStatus = () => ({
    status: "not_ready",
    mode: "stub",
    checks: [{ name: "ffmpeg", available: false, reason: "missing_dependency" }],
    missing: ["ffmpeg"],
    degraded: ["ffmpeg"],
  });

  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.service, "dubroom-server");
    assert.equal(payload.version, "3.2");
    assert.equal(payload.runtime.pipelineMode, "stub");
    assert.equal(payload.dependencies.status, "not_ready");
    assert.equal(payload.dependencies.missing[0], "ffmpeg");
    const metricsResponse = await fetch(`${baseUrl}/v1/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(metricsResponse.headers.get("content-type"), /text\/plain/);
    const metricsBody = await metricsResponse.text();
    assert.match(metricsBody, /dubroom_job_dead_letter 2/);
    assert.match(metricsBody, /dubroom_job_oldest_pending_age_seconds 12/);
    assert.match(metricsBody, /dubroom_disk_free_bytes 2048/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("readiness is unavailable when dependencies are not ready while liveness stays available", async () => {
  const service = new (await import("../server-v2/project-service.mjs")).ProjectService();
  service.health = () => ({
    status: "degraded",
    service: "dubroom-server",
    version: "3.2",
    runtime: null,
    dependencies: { status: "not_ready", checks: [], missing: ["ffmpeg"], degraded: ["ffmpeg"] },
  });
  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const [liveness, readiness] = await Promise.all([
      fetch(`${baseUrl}/v1/health/live`),
      fetch(`${baseUrl}/v1/health/ready`),
    ]);
    assert.equal(liveness.status, 200);
    assert.equal((await liveness.json()).status, "alive");
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).status, "degraded");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("internal HTTP failures do not expose implementation details", async () => {
  const service = {
    get() { throw new Error("sensitive_internal_detail"); },
  };
  const server = createHttpServer({ service, adminToken: "test-admin-token" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/projects/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: "Bearer token" },
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error, "server_error");
    assert.equal(typeof payload.requestId, "string");
    assert.equal(response.headers.get("x-request-id"), payload.requestId);
  } finally {
    server.close();
    await once(server, "close");
  }
});
