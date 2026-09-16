import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { LocalProjectService } from "../server-v2/local-project-service.mjs";
import { LocalJobRepository } from "../server-v2/local-jobs.mjs";
import { LocalProjectRepository } from "../server-v2/local-repository.mjs";
import { LocalTaskQueue } from "../server-v2/local-queue.mjs";
import { LocalRecommendationStore } from "../server-v2/local-recommendations.mjs";
import { MediaTools } from "../server-v2/media-tools.mjs";
import { createProject } from "../server-v2/domain.mjs";
import { defaultServerSettings, LocalSettingsStore } from "../server-v2/local-settings.mjs";
import { createHttpServer } from "../server-v2/http-server.mjs";

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_timeout");
}

test("an admin deletion cannot be resurrected by a background save", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-delete-test-"));
  try {
    const repository = new LocalProjectRepository(root);
    const project = createProject("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    repository.insert(project);
    repository.delete(project.id);
    repository.save(project);
    assert.equal(repository.get(project.id), null);
    assert.equal(existsSync(path.join(root, project.id)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleted owners cannot have job records resurrected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-job-delete-test-"));
  try {
    const jobs = new LocalJobRepository(root);
    const input = { key: "project:owner:stage", ownerType: "project", ownerId: "owner", stage: "stage" };
    jobs.start(input);
    jobs.removeOwner("project", "owner");
    assert.throws(() => jobs.succeed(input), /job_owner_deleted/);
    assert.equal(jobs.list().length, 0);
    assert.equal(readdirSync(path.join(root, "jobs")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job records persist retry waits, dead letters, and manual resets", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-job-state-test-"));
  try {
    const jobs = new LocalJobRepository(root);
    const input = { key: "project:owner:prepare_video", ownerType: "project", ownerId: "owner", stage: "prepare_video" };
    jobs.start(input, 1_000);
    jobs.scheduleRetry(input, "temporary", 3_000, 2_000);
    assert.equal(jobs.stats(2_500).retryWaiting, 1);
    jobs.start(input, 3_000);
    const dead = jobs.deadLetter(input, "still_broken", 4_000);
    assert.equal(dead.attempts, 2);
    assert.equal(jobs.stats(5_000).deadLetter, 1);
    assert.equal(new LocalJobRepository(root).listDeadLetters()[0].error, "still_broken");
    jobs.resetOwnerFailures("project", "owner", 6_000);
    const reset = jobs.getById(dead.id);
    assert.equal(reset.state, "PENDING");
    assert.equal(reset.attempts, 0);
    assert.equal(reset.error, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local stages retry with backoff while ElevenLabs stages stop after one attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-job-policy-test-"));
  try {
    const repository = new LocalProjectRepository(root);
    const settingsStore = {
      get: () => ({ ...defaultServerSettings, maxAutomaticJobAttempts: 3, retryBaseDelaySeconds: 0.001 }),
    };
    const service = new LocalProjectService({ repository, settingsStore, autoStart: false });
    let attempts = 0;
    let complete = false;
    while (!complete) {
      try {
        await service.runJob({
          ownerType: "project",
          ownerId: "retry-owner",
          stage: "youtube_download",
          complete: () => complete,
          run: () => {
            attempts += 1;
            if (attempts < 3) throw new Error("temporary_network_failure");
            complete = true;
          },
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "job_retry_scheduled") throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(error.nextAttemptAt) - Date.now())));
      }
    }
    assert.equal(attempts, 3);
    assert.equal(service.jobRepository.stats().deadLetter, 0);

    let providerAttempts = 0;
    await assert.rejects(() => service.runJob({
      ownerType: "project",
      ownerId: "provider-owner",
      stage: "elevenlabs_stems",
      complete: () => false,
      run: () => {
        providerAttempts += 1;
        throw new Error("elevenlabs_stems_failed:provider_unavailable");
      },
    }), /elevenlabs_stems_failed/);
    assert.equal(providerAttempts, 1);
    assert.equal(service.jobRepository.listDeadLetters()[0].stage, "elevenlabs_stems");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server limits persist and reject unsafe values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-settings-test-"));
  try {
    const store = new LocalSettingsStore(root);
    assert.deepEqual(store.get(), defaultServerSettings);
    assert.equal(store.get().maxProjectCreationsPerMinute, 6);
    assert.equal(store.get().minFreeStorageGb, 1);
    assert.equal(store.get().maxAutomaticJobAttempts, 3);
    const updated = store.update({ ...store.get(), projectRetentionMinutes: 90, maxProjects: 25, maxTotalStorageGb: 20, maxCacheStorageGb: 10 });
    assert.equal(updated.projectRetentionMinutes, 90);
    assert.equal(new LocalSettingsStore(root).get().maxProjects, 25);
    assert.throws(() => store.update({ ...store.get(), maxTotalStorageGb: 5, maxCacheStorageGb: 6 }), /invalid_setting:maxCacheStorageGb/);
    assert.throws(() => store.update({ ...store.get(), projectRetentionMinutes: 0 }), /invalid_setting:projectRetentionMinutes/);
    assert.throws(() => store.update({ ...store.get(), minFreeStorageGb: 0 }), /invalid_setting:minFreeStorageGb/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real mode fails fast when required runtime dependencies are missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-dependency-test-"));
  try {
    const repository = new LocalProjectRepository(root);
    const invalid = new LocalProjectService({
      repository,
      media: { ffmpeg: "", ffprobe: "", extractAudio() {}, inspect() {}, normalizeVideo() {}, assembleDub() {}, createStubVideo() {}, createVideoPoster() {}, normalizePoster() {} },
      youtube: { executable: "", inspect() {}, download() {} },
      pipelineMode: "real",
      elevenLabs: null,
    });
    const invalidStatus = invalid.dependencyStatus();
    assert.equal(invalidStatus.status, "not_ready");
    assert.equal(invalidStatus.missing.includes("ffmpeg"), true);
    assert.equal(invalidStatus.missing.includes("ffprobe"), true);
    assert.equal(invalidStatus.missing.includes("yt_dlp"), true);
    assert.equal(invalidStatus.missing.includes("elevenlabs_api_key"), true);
    assert.throws(() => invalid.verifyRuntimeDependencies(), /runtime_dependency_check_failed/);

    const validExecutable = process.execPath;
    const valid = new LocalProjectService({
      repository,
      media: { ffmpeg: validExecutable, ffprobe: validExecutable },
      youtube: { executable: validExecutable, inspect() {}, download() {} },
      pipelineMode: "real",
      elevenLabs: { apiKey: "token", separateStems() {}, transcribe() {} },
    });
    const validStatus = valid.dependencyStatus();
    assert.equal(validStatus.status, "ready");
    assert.equal(validStatus.missing.length, 0);
    assert.doesNotThrow(() => valid.verifyRuntimeDependencies());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local queue drains accepted work and rejects work added after shutdown", async () => {
  const queue = new LocalTaskQueue({ concurrency: 1 });
  const order = [];
  const first = queue.add(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push("first");
  });
  const second = queue.add(() => order.push("second"));
  const closed = queue.close();

  await assert.rejects(() => queue.add(() => undefined), /queue_closed/);
  await Promise.all([first, second, closed]);
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(queue.stats(), { concurrency: 1, running: 0, pending: 0, accepting: false });
});

test("startup recovery can be deferred until dependencies are verified", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-deferred-start-"));
  try {
    const repository = new LocalProjectRepository(root);
    const interrupted = createProject("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    interrupted.state = "INGESTING";
    repository.insert(interrupted);
    let stubRuns = 0;
    const service = new LocalProjectService({
      repository,
      autoStart: false,
      pipelineMode: "stub",
      media: {
        ffmpeg: process.execPath,
        ffprobe: process.execPath,
        createStubVideo: async (target) => { stubRuns += 1; writeFileSync(target, new Uint8Array([1])); },
        extractAudio: async (input, target) => writeFileSync(target, new Uint8Array([2])),
      },
    });

    assert.equal(stubRuns, 0);
    assert.equal(repository.get(interrupted.id).state, "INGESTING");
    service.verifyRuntimeDependencies();
    service.start();
    await waitFor(() => service.get(interrupted.id, interrupted.token).state === "READY_TO_DUB");
    assert.equal(stubRuns, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline failures keep diagnostics private", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-private-error-"));
  try {
    const repository = new LocalProjectRepository(root);
    const service = new LocalProjectService({
      repository,
      pipelineMode: "stub",
      media: {
        ffmpeg: process.execPath,
        ffprobe: process.execPath,
        createStubVideo: async () => { throw new Error("C:/private/path/provider-detail"); },
      },
    });
    const created = service.create({ sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsAccepted: true });
    await waitFor(() => service.get(created.project.id, created.token).state === "FAILED");

    assert.equal(service.get(created.project.id, created.token).error, "pipeline_failed");
    assert.equal(repository.get(created.project.id).errorDetail, "C:/private/path/provider-detail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recommendations are normalized and never removed by project TTL cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-recommendations-"));
  try {
    const repository = new LocalProjectRepository(root);
    let recommendationAudioExtractions = 0;
    let posterNormalizations = 0;
    const media = {
      inspect: async () => ({ duration: 8.5, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac" }),
      normalizeVideo: async (input, output) => writeFileSync(output, readFileSync(input)),
      createVideoPoster: async (input, output) => writeFileSync(output, new Uint8Array([9, 8, 7])),
      normalizePoster: async (input, output) => { posterNormalizations += 1; writeFileSync(output, new Uint8Array([6, 5, 4])); },
      extractAudio: async (input, output) => { recommendationAudioExtractions += 1; writeFileSync(output, new Uint8Array([4, 3, 2, 1])); },
    };
    let youtubeDownloads = 0;
    const youtube = {
      inspect: async () => ({ title: "Название из YouTube", duration: 8.5, videoId: "dQw4w9WgXcQ" }),
      download: async (url, directory) => {
        youtubeDownloads += 1;
        const target = path.join(directory, "downloaded.mp4");
        writeFileSync(target, new Uint8Array([5, 6, 7, 8]));
        return target;
      },
    };
    const elevenLabsCalls = { stems: 0, transcript: 0 };
    const elevenLabs = {
      separateStems: async () => {
        elevenLabsCalls.stems += 1;
        return zipSync({
          "result/instrumental.mp3": new Uint8Array([10, 11]),
          "result/vocals.mp3": new Uint8Array([12, 13]),
        });
      },
      transcribe: async () => {
        elevenLabsCalls.transcript += 1;
        return { words: [
          { type: "word", text: "Постоянная", start: 0.2, end: 0.6 },
          { type: "word", text: "реплика.", start: 0.62, end: 1.1 },
        ] };
      },
    };
    const service = new LocalProjectService({ repository, youtube, media, elevenLabs, pipelineMode: "real" });
    const firstCategory = service.createAdminRecommendationCategory({ name: "  Комедия  " });
    const secondCategory = service.createAdminRecommendationCategory({ name: "Мультфильмы" });
    assert.equal(firstCategory.name, "Комедия");
    assert.throws(() => service.createAdminRecommendationCategory({ name: "комедия" }), /recommendation_category_name_conflict/);
    const created = service.createAdminRecommendation({
      title: "Постоянная рекомендация",
      originalName: "clip.mp4",
      bytes: new Uint8Array([1, 2, 3, 4]),
      categoryId: firstCategory.id,
    });
    const ready = await waitFor(() => service.listAdminRecommendations().find((item) => item.id === created.id && item.state === "READY"));
    assert.equal(ready.title, "Постоянная рекомендация");
    assert.equal(ready.categoryId, firstCategory.id);
    assert.equal(ready.shareUrl, `/?recommendation=${created.id}`);
    assert.equal(service.getRecommendation(created.id).id, created.id);
    assert.equal(service.listRecommendations().length, 1);
    assert.equal(existsSync(path.join(root, "recommendations", created.id, "video.mp4")), true);
    assert.equal(existsSync(path.join(root, "recommendations", created.id, "instrumental.mp3")), true);
    assert.equal(existsSync(path.join(root, "recommendations", created.id, "transcript.json")), true);
    assert.equal(elevenLabsCalls.stems, 1);
    assert.equal(elevenLabsCalls.transcript, 1);
    const originalPosterUrl = ready.posterUrl;
    const updatedPoster = await service.updateAdminRecommendationPoster(created.id, {
      originalName: "custom-preview.png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    assert.equal(posterNormalizations, 1);
    assert.notEqual(updatedPoster.posterUrl, originalPosterUrl);
    assert.deepEqual([...readFileSync(path.join(root, "recommendations", created.id, "poster.jpg"))], [6, 5, 4]);
    assert.equal(elevenLabsCalls.stems, 1);
    assert.equal(elevenLabsCalls.transcript, 1);
    await assert.rejects(() => service.updateAdminRecommendationPoster(created.id, { originalName: "preview.gif", bytes: new Uint8Array([1]) }), /invalid_recommendation_poster/);
    const renamedCategory = service.updateAdminRecommendationCategory(firstCategory.id, { name: "Юмор" });
    assert.equal(renamedCategory.name, "Юмор");
    assert.equal(service.listRecommendationCategories().length, 2);
    service.setAdminRecommendationCategory(created.id, { categoryId: secondCategory.id });
    assert.equal(service.getRecommendation(created.id).categoryId, secondCategory.id);
    service.removeAdminRecommendationCategory(secondCategory.id);
    assert.equal(service.getRecommendation(created.id).categoryId, null);
    assert.equal(service.listRecommendationCategories()[0].name, "Юмор");
    assert.equal(new LocalRecommendationStore(root).listCategories()[0].name, "Юмор");
    assert.equal(service.recommendationAsset(created.id, "video").contentType, "video/mp4");
    const selected = service.createFromRecommendation(created.id);
    const selectedReady = await waitFor(() => {
      const project = service.get(selected.project.id, selected.token);
      return project.state === "READY_TO_DUB" ? project : null;
    });
    assert.equal(selectedReady.sourceUrl, `/recommendations/${created.id}`);
    assert.equal(selectedReady.title, "Постоянная рекомендация");
    assert.equal(recommendationAudioExtractions, 1);
    const selectedAgain = service.createFromRecommendation(created.id);
    await waitFor(() => service.get(selectedAgain.project.id, selectedAgain.token).state === "READY_TO_DUB");
    assert.equal(recommendationAudioExtractions, 1);
    assert.equal(elevenLabsCalls.stems, 1);
    assert.equal(elevenLabsCalls.transcript, 1);
    const youtubeCreated = service.createAdminRecommendationFromYouTube({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ" });
    const youtubeReady = await waitFor(() => service.listAdminRecommendations().find((item) => item.id === youtubeCreated.id && item.state === "READY"));
    assert.equal(youtubeReady.title, "Название из YouTube");
    assert.equal(youtubeReady.sourceType, "youtube");
    assert.equal(youtubeDownloads, 1);
    assert.equal(elevenLabsCalls.stems, 2);
    assert.equal(elevenLabsCalls.transcript, 2);
    const duplicate = service.createAdminRecommendationFromYouTube({ sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    assert.equal(duplicate.id, youtubeCreated.id);
    assert.equal(youtubeDownloads, 1);
    service.cleanup(Date.now() + 365 * 24 * 60 * 60 * 1000);
    assert.equal(service.listRecommendations().length, 2);
    assert.equal(service.adminSettings().storage.recommendationCount, 2);
    assert.equal(service.listRecommendationCategories().length, 1);
    const selectedAfterProjectTtl = service.createFromRecommendation(created.id);
    await waitFor(() => service.get(selectedAfterProjectTtl.project.id, selectedAfterProjectTtl.token).state === "READY_TO_DUB");
    assert.equal(elevenLabsCalls.stems, 2);
    assert.equal(elevenLabsCalls.transcript, 2);
    service.removeAdminRecommendation(created.id);
    service.removeAdminRecommendation(youtubeCreated.id);
    assert.equal(service.listRecommendations().length, 0);
    assert.throws(() => service.getRecommendation(created.id), /recommendation_not_found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy recommendations are permanently prepared once during startup migration", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-recommendation-migration-"));
  try {
    const store = new LocalRecommendationStore(root);
    const entry = store.create({ title: "Старая рекомендация", originalName: "legacy.mp4", bytes: new Uint8Array([1, 2, 3]) });
    writeFileSync(path.join(store.directory(entry.id), "video.mp4"), new Uint8Array([4, 5, 6]));
    rmSync(store.sourcePath(entry.id), { force: true });
    entry.state = "READY";
    entry.progress = 100;
    entry.sourceFile = null;
    entry.videoFile = "video.mp4";
    entry.media = {};
    entry.cues = [];
    store.save(entry);

    const calls = { stems: 0, transcript: 0 };
    const media = {
      inspect: async () => ({ duration: 6, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac" }),
      createVideoPoster: async (input, output) => writeFileSync(output, new Uint8Array([7])),
      extractAudio: async (input, output) => writeFileSync(output, new Uint8Array([8, 9])),
    };
    const elevenLabs = {
      separateStems: async () => {
        calls.stems += 1;
        return zipSync({ "result/instrumental.mp3": new Uint8Array([10]) });
      },
      transcribe: async () => {
        calls.transcript += 1;
        return { words: [{ type: "word", text: "Готово.", start: 0.2, end: 0.8 }] };
      },
    };
    const firstService = new LocalProjectService({
      repository: new LocalProjectRepository(root),
      recommendationStore: store,
      media,
      elevenLabs,
      pipelineMode: "real",
    });
    await waitFor(() => firstService.listAdminRecommendations().find((item) => item.id === entry.id && item.state === "READY" && item.preparedAt));
    assert.deepEqual(calls, { stems: 1, transcript: 1 });

    const secondService = new LocalProjectService({
      repository: new LocalProjectRepository(root),
      recommendationStore: new LocalRecommendationStore(root),
      media,
      elevenLabs,
      pipelineMode: "real",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(calls, { stems: 1, transcript: 1 });
    const selected = secondService.createFromRecommendation(entry.id);
    await waitFor(() => secondService.get(selected.project.id, selected.token).state === "READY_TO_DUB");
    assert.deepEqual(calls, { stems: 1, transcript: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local real pipeline persists media, takes, and final MP4", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-test-"));
  try {
    const repository = new LocalProjectRepository(root);
    const calls = { inspect: 0, download: 0, stems: 0, transcript: 0 };
    const youtube = {
      inspect: async () => { calls.inspect += 1; return { title: "Public own video", duration: 4, videoId: "dQw4w9WgXcQ" }; },
      download: async (url, directory, projectId) => {
        calls.download += 1;
        const target = path.join(directory, `${projectId}.mp4`);
        writeFileSync(target, new Uint8Array([1, 2, 3]));
        return target;
      },
    };
    const media = {
      inspect: async () => ({ duration: 4, videoCodec: "h264", canCopyVideoToMp4: true }),
      extractAudio: async (input, output) => { writeFileSync(output, new Uint8Array([4, 5, 6])); },
      normalizeVideo: async () => { throw new Error("unexpected_normalize"); },
      assembleDub: async ({ outputPath }) => { writeFileSync(outputPath, new Uint8Array([7, 8, 9])); },
    };
    const elevenLabs = {
      separateStems: async () => { calls.stems += 1; return zipSync({
        "result/instrumental.mp3": new Uint8Array([10, 11]),
        "result/vocals.mp3": new Uint8Array([12, 13]),
      }); },
      transcribe: async () => { calls.transcript += 1; return { words: [
        { type: "word", text: "Первая", start: 0.2, end: 0.5 },
        { type: "word", text: "реплика.", start: 0.52, end: 1.0 },
        { type: "word", text: "Вторая", start: 2.0, end: 2.4 },
        { type: "word", text: "реплика.", start: 2.42, end: 3.0 },
      ] }; },
    };
    const service = new LocalProjectService({ repository, youtube, media, elevenLabs, pipelineMode: "real" });
    const created = service.create({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true });
    const duplicate = service.create({ sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", rightsAccepted: true });
    const projectId = created.project.id;
    const token = created.token;
    assert.equal(created.project.workingExpiresAt - created.project.createdAt, 60 * 60 * 1000);
    const ready = await waitFor(() => {
      const project = service.get(projectId, token);
      if (project.state === "FAILED") throw new Error(project.error);
      return project.state === "READY_TO_DUB" ? project : null;
    });
    assert.equal(ready.cues.length, 2);
    assert.equal(existsSync(path.join(root, projectId, "instrumental.mp3")), true);
    assert.equal(new LocalProjectRepository(root).get(projectId).title, "Public own video");

    const reused = await waitFor(() => {
      const project = service.get(duplicate.project.id, duplicate.token);
      if (project.state === "FAILED") throw new Error(project.error);
      return project.state === "READY_TO_DUB" ? project : null;
    });
    assert.notEqual(reused.id, ready.id);
    assert.equal(service.adminSettings().storage.cacheCount, 1);
    assert.deepEqual(reused.recordedCueIds, []);
    assert.deepEqual(calls, { inspect: 1, download: 1, stems: 1, transcript: 1 });
    assert.equal(existsSync(path.join(root, reused.id, "prepared.mp4")), true);
    assert.equal(existsSync(path.join(root, reused.id, "instrumental.mp3")), true);

    const manifest = service.manifest(projectId, token);
    assert.match(manifest.videoUrl, /media\/prepared/);
    assert.equal(new URL(manifest.videoUrl, "http://localhost").searchParams.has("token"), false);
    const mediaServer = createHttpServer({ service, adminToken: "test-admin-token" });
    mediaServer.listen(0, "127.0.0.1");
    await once(mediaServer, "listening");
    const mediaAddress = mediaServer.address();
    const mediaBaseUrl = `http://127.0.0.1:${mediaAddress.port}`;
    try {
      const signedMedia = await fetch(`${mediaBaseUrl}${manifest.videoUrl}`);
      assert.equal(signedMedia.status, 200);
      assert.deepEqual(new Uint8Array(await signedMedia.arrayBuffer()), new Uint8Array([1, 2, 3]));

      const legacyTokenMedia = await fetch(`${mediaBaseUrl}/v1/projects/${projectId}/media/prepared?token=${encodeURIComponent(token)}`);
      assert.equal(legacyTokenMedia.status, 401);

      const parsedSignedUrl = new URL(manifest.videoUrl, mediaBaseUrl);
      parsedSignedUrl.pathname = `/v1/projects/${projectId}/media/instrumental`;
      const tamperedMedia = await fetch(parsedSignedUrl);
      assert.equal(tamperedMedia.status, 401);
    } finally {
      mediaServer.close();
      await once(mediaServer, "close");
    }
    await assert.rejects(async () => service.saveTake(projectId, token, manifest.cues[0].id, Buffer.from([1, 2, 3]), { revision: 99 }), /manifest_revision_mismatch/);
    for (const cue of manifest.cues) service.saveTake(projectId, token, cue.id, Buffer.from([1, 2, 3]), { revision: manifest.revision });
    assert.equal(Object.keys(service.manifest(projectId, token).takeUrls).length, manifest.cues.length);
    service.finalize(projectId, token);
    service.finalize(projectId, token);
    const complete = await waitFor(() => {
      const project = service.get(projectId, token);
      return project.state === "READY" ? project : null;
    });
    assert.equal(complete.progress, 100);
    assert.equal(service.finalize(projectId, token).state, "READY");
    assert.equal(existsSync(path.join(root, projectId, "result.mp4")), true);

    service.cleanup(repository.get(projectId).workingExpiresAt + 1);
    assert.equal(existsSync(path.join(root, projectId, "result.mp4")), false);
    assert.equal(repository.get(projectId), null);
    assert.equal(existsSync(path.join(root, "cache", "dQw4w9WgXcQ", "prepared.mp4")), true);
    assert.equal(existsSync(path.join(root, "cache", "dQw4w9WgXcQ", "instrumental.mp3")), true);

    const afterWorkingCleanup = service.create({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true });
    const reusedAfterCleanup = await waitFor(() => {
      const project = service.get(afterWorkingCleanup.project.id, afterWorkingCleanup.token);
      if (project.state === "FAILED") throw new Error(project.error);
      return project.state === "READY_TO_DUB" ? project : null;
    });
    assert.equal(reusedAfterCleanup.cues.length, 2);
    assert.deepEqual(calls, { inspect: 1, download: 1, stems: 1, transcript: 1 });
    assert.equal(service.listAdminCache().length, 1);
    service.removeAdminCache("dQw4w9WgXcQ");
    assert.equal(service.listAdminCache().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart resumes analysis without repeating completed ElevenLabs work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-analysis-resume-"));
  try {
    const repository = new LocalProjectRepository(root);
    const project = createProject("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    project.state = "ANALYZING";
    project.title = "Recovered video";
    project.duration = 4;
    project.progress = 60;
    project.media = { prepared: "prepared.mp4", master: "master.wav", stems: "stems.zip" };
    project.stemsStatus = "running";
    project.transcriptStatus = "running";
    repository.insert(project);
    const directory = repository.directory(project.id);
    writeFileSync(path.join(directory, "prepared.mp4"), new Uint8Array([1, 2, 3]));
    writeFileSync(path.join(directory, "master.wav"), new Uint8Array([4, 5, 6]));
    writeFileSync(path.join(directory, "stems.zip"), zipSync({
      "result/instrumental.mp3": new Uint8Array([7, 8]),
      "result/vocals.mp3": new Uint8Array([9, 10]),
    }));

    const jobs = new LocalJobRepository(root);
    jobs.start({
      key: `project:${project.id}:elevenlabs_stems`,
      ownerType: "project",
      ownerId: project.id,
      stage: "elevenlabs_stems",
    });
    jobs.start({
      key: `project:${project.id}:elevenlabs_transcript`,
      ownerType: "project",
      ownerId: project.id,
      stage: "elevenlabs_transcript",
    });

    const calls = { youtube: 0, stems: 0, transcript: 0 };
    const service = new LocalProjectService({
      repository: new LocalProjectRepository(root),
      jobRepository: new LocalJobRepository(root),
      pipelineMode: "real",
      youtube: {
        inspect: async () => { calls.youtube += 1; throw new Error("youtube_should_not_run"); },
        download: async () => { calls.youtube += 1; throw new Error("youtube_should_not_run"); },
      },
      media: {
        ffmpeg: process.execPath,
        ffprobe: process.execPath,
        inspect: async () => ({ duration: 4, videoCodec: "h264", canCopyVideoToMp4: true }),
        extractAudio: async () => { throw new Error("extract_should_not_run"); },
      },
      elevenLabs: {
        apiKey: "test",
        separateStems: async () => { calls.stems += 1; throw new Error("stems_should_not_run"); },
        transcribe: async () => {
          calls.transcript += 1;
          return { words: [{ type: "word", text: "Восстановлено.", start: 0.2, end: 0.9 }] };
        },
      },
    });
    await waitFor(() => service.get(project.id, project.token).state === "READY_TO_DUB");

    assert.deepEqual(calls, { youtube: 0, stems: 0, transcript: 1 });
    const persistedJobs = new LocalJobRepository(root).list();
    const stemsJob = persistedJobs.find((job) => job.stage === "elevenlabs_stems");
    const transcriptJob = persistedJobs.find((job) => job.stage === "elevenlabs_transcript");
    assert.equal(stemsJob.state, "SUCCEEDED");
    assert.equal(stemsJob.attempts, 1);
    assert.equal(transcriptJob.state, "SUCCEEDED");
    assert.equal(transcriptJob.attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers interrupted preparation and retries failed projects", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-recovery-test-"));
  try {
    const repository = new LocalProjectRepository(root);
    const interrupted = createProject("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    interrupted.state = "INGESTING";
    interrupted.progress = 20;
    repository.insert(interrupted);
    const failed = createProject("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    failed.state = "FAILED";
    failed.error = "temporary_failure";
    repository.insert(failed);
    const media = {
      createStubVideo: async (target) => writeFileSync(target, new Uint8Array([1, 2, 3])),
      extractAudio: async (input, target) => writeFileSync(target, new Uint8Array([4, 5, 6])),
    };
    const service = new LocalProjectService({ repository, media, pipelineMode: "stub" });
    await waitFor(() => service.get(interrupted.id, interrupted.token).state === "READY_TO_DUB");
    assert.equal(repository.get(interrupted.id).events.at(-1).state, "READY_TO_DUB");
    assert.equal(service.retryAdminProject(failed.id).state, "CREATED");
    await waitFor(() => service.get(failed.id, failed.token).state === "READY_TO_DUB");
    assert.equal(service.runtimeStats().status, "ready");
    assert.equal(service.runtimeStats().queue.pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const localFfmpeg = path.resolve("backend", "tools", "ffmpeg.exe");

test("local stub runs through FFmpeg and produces a playable MP4", { skip: !existsSync(localFfmpeg) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dubroom-v2-ffmpeg-"));
  try {
    const repository = new LocalProjectRepository(root);
    const media = new MediaTools({ ffmpeg: localFfmpeg, ffprobe: path.resolve("backend", "tools", "ffprobe.exe") });
    const service = new LocalProjectService({ repository, media, pipelineMode: "stub" });
    const created = service.create({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ", rightsAccepted: true });
    const ready = await waitFor(() => {
      const project = service.get(created.project.id, created.token);
      if (project.state === "FAILED") throw new Error(project.error);
      return project.state === "READY_TO_DUB" ? project : null;
    }, 30_000);
    const directory = repository.directory(ready.id);
    const takeBytes = readFileSync(path.join(directory, "instrumental.wav"));
    for (const cue of ready.cues) {
      service.saveTake(ready.id, created.token, cue.id, takeBytes, { revision: ready.manifestRevision });
    }
    service.finalize(ready.id, created.token);
    const complete = await waitFor(() => {
      const project = service.get(ready.id, created.token);
      if (project.state === "FAILED") throw new Error(project.error);
      return project.state === "READY" ? project : null;
    }, 30_000);
    const result = path.join(directory, "result.mp4");
    assert.equal(existsSync(result), true);
    assert.ok(statSync(result).size > 10_000);
    assert.equal(complete.progress, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
