import { randomUUID } from "node:crypto";
import { constants as fsConstants, accessSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { unzipSync } from "fflate";
import { buildCues } from "./cues.mjs";
import { createProject, publicProject, recoverProject, touchProject, transitionProject } from "./domain.mjs";
import { ElevenLabsClient } from "./elevenlabs.mjs";
import { LocalJobRepository } from "./local-jobs.mjs";
import { LocalTaskQueue } from "./local-queue.mjs";
import { LocalSettingsStore, settingLimits } from "./local-settings.mjs";
import { LocalRecommendationStore } from "./local-recommendations.mjs";
import { LocalSourceCache } from "./local-source-cache.mjs";
import { MediaTools, YouTubeSource } from "./media-tools.mjs";
import { createSignedProjectUrl, verifySignedProjectUrl } from "./project-media-auth.mjs";
import { parsePublicYouTubeUrl } from "./youtube.mjs";

function safeAssetName(value) {
  const name = path.basename(String(value || ""));
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(name)) throw new Error("invalid_asset_name");
  return name;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg" || extension === ".oga") return "audio/ogg";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

function findStem(entries, stem) {
  return Object.entries(entries).find(([name, bytes]) => {
    const baseName = path.posix.basename(name.replace(/\\/g, "/")).toLowerCase();
    return bytes.length && baseName.includes(stem.toLowerCase()) && /\.(wav|mp3|ogg|m4a)$/.test(baseName);
  });
}

function publicPipelineError(error) {
  const message = error instanceof Error ? error.message : "pipeline_failed";
  const code = message.split(":", 1)[0];
  const safeCodes = new Set([
    "invalid_source_media",
    "source_duration_limit_exceeded",
    "source_size_limit_exceeded",
    "storage_limit_reached",
    "disk_space_low",
    "youtube_duration_not_supported",
    "youtube_download_output_missing",
    "transcript_contains_no_cues",
    "instrumental_stem_missing",
    "process_timeout",
  ]);
  if (safeCodes.has(code)) return code;
  if (/sign in to confirm you.re not a bot|cookies-from-browser/i.test(message)) return "youtube_auth_required";
  if (/youtube_video_not_public/i.test(message)) return "youtube_video_not_public";
  if (/elevenlabs_api_key_missing/i.test(message)) return "elevenlabs_api_key_missing";
  if (/elevenlabs_paid_plan_required|paid_plan_required/i.test(message)) return "elevenlabs_paid_plan_required";
  if (/elevenlabs_stems_failed/i.test(message)) return "elevenlabs_stems_failed";
  if (/elevenlabs_transcript_failed/i.test(message)) return "elevenlabs_transcript_failed";
  return "pipeline_failed";
}

function recordPipelineFailure(target, kind, id, error) {
  const detail = (error instanceof Error ? error.message : String(error || "pipeline_failed")).slice(0, 4_000);
  target.error = publicPipelineError(error);
  target.errorDetail = detail;
  console.error(JSON.stringify({ level: "error", event: "pipeline_failed", kind, id, error: detail }));
}

const reusableMediaKeys = ["source", "prepared", "master", "stems", "transcript", "instrumental", "vocals"];
const automaticRetryStages = new Set(["youtube_download", "prepare_video", "extract_master", "final_render"]);
const nonRetryablePipelineErrors = new Set([
  "invalid_source_media",
  "source_duration_limit_exceeded",
  "source_size_limit_exceeded",
  "storage_limit_reached",
  "disk_space_low",
  "youtube_auth_required",
  "youtube_video_not_public",
  "elevenlabs_api_key_missing",
  "elevenlabs_paid_plan_required",
]);

function canAutomaticallyRetry(stage, error) {
  return automaticRetryStages.has(stage) && !nonRetryablePipelineErrors.has(publicPipelineError(error));
}

function retryScheduled(nextAttemptAt) {
  const error = new Error("job_retry_scheduled");
  error.nextAttemptAt = Number(nextAttemptAt) || Date.now();
  return error;
}

function scheduledRetryAt(error) {
  return error instanceof Error && error.message === "job_retry_scheduled" ? Number(error.nextAttemptAt) || Date.now() : null;
}

function cloneFile(source, target) {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function directoryBytes(directory, seen = new Set()) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target, seen);
    else if (entry.isFile()) {
      const stats = statSync(target);
      const identity = `${stats.dev}:${stats.ino}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      total += stats.size;
    }
  }
  return total;
}

function checkExecutable(name, executable) {
  const configured = String(executable || "").trim();
  if (!configured) {
    return { name, configured: false, available: false, required: true, reason: "not_configured" };
  }
  if (path.isAbsolute(configured) && !existsSync(configured)) {
    return { name, configured: configured, available: false, required: true, reason: "missing_file" };
  }
  const probe = spawnSync(configured, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (probe.error) {
    return {
      name,
      configured,
      available: false,
      required: true,
      reason: probe.error.code === "ETIMEDOUT" ? "probe_timeout" : "not_executable",
    };
  }
  return { name, configured, available: true, required: true, reason: null };
}

function checkSecret(name, value) {
  const present = Boolean(String(value || "").trim());
  return {
    name,
    available: present,
    required: true,
    reason: present ? null : "missing_secret",
  };
}

function checkDirectory(name, directoryPath, required = true) {
  const resolved = path.resolve(String(directoryPath || ""));
  let available = false;
  try {
    accessSync(resolved, fsConstants.R_OK | fsConstants.W_OK);
    available = true;
  } catch {
    available = false;
  }
  return {
    name,
    configured: resolved,
    available,
    required,
    reason: available ? null : existsSync(resolved) ? "directory_not_writable" : "missing_directory",
  };
}

function filesystemStats(directory) {
  try {
    const stats = statfsSync(directory);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export class LocalProjectService {
  constructor({
    repository,
    queue = new LocalTaskQueue({ concurrency: Number(process.env.DUBROOM_PIPELINE_CONCURRENCY || 1) }),
    youtube = new YouTubeSource(),
    media = new MediaTools(),
    elevenLabs = null,
    pipelineMode = process.env.DUBROOM_PIPELINE_MODE || "stub",
    stemOutputFormat = process.env.ELEVENLABS_STEM_OUTPUT_FORMAT || "mp3_44100_128",
    settingsStore = new LocalSettingsStore(repository.rootDirectory),
    sourceCache = new LocalSourceCache(repository.rootDirectory),
    recommendationStore = new LocalRecommendationStore(repository.rootDirectory),
    jobRepository = new LocalJobRepository(repository.rootDirectory),
    mediaUrlTtlSeconds = Number(process.env.DUBROOM_MEDIA_URL_TTL_SECONDS || 3600),
    autoStart = true,
  }) {
    this.repository = repository;
    this.queue = queue;
    this.youtube = youtube;
    this.media = media;
    this.elevenLabs = elevenLabs;
    this.pipelineMode = pipelineMode;
    this.stemOutputFormat = stemOutputFormat;
    this.settingsStore = settingsStore;
    this.sourceCache = sourceCache;
    this.recommendationStore = recommendationStore;
    this.jobRepository = jobRepository;
    this.mediaUrlTtlSeconds = mediaUrlTtlSeconds;
    this.runningProjects = new Set();
    this.sourcePreparations = new Map();
    this.startedAt = Date.now();
    this.started = false;
    this.queue.setConcurrency?.(this.settingsStore.get().pipelineConcurrency);
    if (autoStart) this.start();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.migrateReusableProjectsToCache();
    this.applyProjectRetention();
    this.cleanup();
    this.recoverInterruptedProjects();
    this.recoverRecommendations();
  }

  jobInput(ownerType, ownerId, stage) {
    return { key: `${ownerType}:${ownerId}:${stage}`, ownerType, ownerId, stage };
  }

  async runJob({ ownerType, ownerId, stage, complete, run }) {
    const input = this.jobInput(ownerType, ownerId, stage);
    if (complete()) {
      this.jobRepository.succeed(input);
      return;
    }
    const settings = this.settingsStore.get();
    const maximumAttempts = automaticRetryStages.has(stage) ? settings.maxAutomaticJobAttempts : 1;
    let job = this.jobRepository.getOrCreate(input);
    if (job.state === "RETRY_WAIT" && job.nextAttemptAt > Date.now()) throw retryScheduled(job.nextAttemptAt);
    if (job.state === "DEAD_LETTER" && job.attempts >= maximumAttempts) throw new Error(job.error || "job_attempts_exhausted");
    job = this.jobRepository.start(input);
    try {
      await run();
      if (!complete()) throw new Error("job_output_missing");
      this.jobRepository.succeed(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!canAutomaticallyRetry(stage, error) || job.attempts >= maximumAttempts) {
        this.jobRepository.deadLetter(input, message);
        throw error;
      }
      const delaySeconds = settings.retryBaseDelaySeconds * 2 ** Math.max(0, job.attempts - 1);
      job = this.jobRepository.scheduleRetry(input, message, Date.now() + delaySeconds * 1000);
      console.warn(JSON.stringify({ level: "warn", event: "job_retry_scheduled", ownerType, ownerId, stage, attempt: job.attempts, delaySeconds }));
      throw retryScheduled(job.nextAttemptAt);
    }
  }

  recoverMedia(directory, current = {}) {
    const media = {};
    for (const [key, fileName] of Object.entries(current || {})) {
      try {
        const name = safeAssetName(fileName);
        if (existsSync(path.join(directory, name))) media[key] = name;
      } catch {
        // Invalid legacy paths are excluded from recovery.
      }
    }
    for (const [key, name] of Object.entries({
      source: "source.mp4",
      prepared: "prepared.mp4",
      master: "master.wav",
      stems: "stems.zip",
      transcript: "transcript.json",
    })) {
      if (existsSync(path.join(directory, name))) media[key] = name;
    }
    for (const name of readdirSync(directory)) {
      if (/^instrumental\.(wav|mp3|ogg|m4a)$/i.test(name)) media.instrumental = name;
      if (/^vocals\.(wav|mp3|ogg|m4a)$/i.test(name)) media.vocals = name;
    }
    return media;
  }

  validStemArchive(filePath) {
    try {
      return Boolean(findStem(unzipSync(readFileSync(filePath)), "instrumental"));
    } catch {
      return false;
    }
  }

  readTranscript(filePath) {
    try {
      const transcript = JSON.parse(readFileSync(filePath, "utf8"));
      return Array.isArray(transcript?.words) ? transcript : null;
    } catch {
      return null;
    }
  }

  async analyzeAudio(target, { ownerType, ownerId, directory, transcriptProjectId, save }) {
    if (!this.elevenLabs) this.elevenLabs = new ElevenLabsClient();
    target.media = this.recoverMedia(directory, target.media);
    const masterPath = path.join(directory, target.media.master || "master.wav");
    const stemsPath = path.join(directory, "stems.zip");
    const transcriptPath = path.join(directory, "transcript.json");
    const audio = new Blob([readFileSync(masterPath)], { type: "audio/wav" });

    const stemsTask = async () => {
      target.stemsStatus = this.validStemArchive(stemsPath) ? "ready" : "running";
      save();
      try {
        await this.runJob({
          ownerType,
          ownerId,
          stage: "elevenlabs_stems",
          complete: () => this.validStemArchive(stemsPath),
          run: async () => {
            const archive = await this.elevenLabs.separateStems({ audio, outputFormat: this.stemOutputFormat });
            writeFileSync(stemsPath, archive);
          },
        });
        target.media.stems = "stems.zip";
        target.stemsStatus = "ready";
        save();
      } catch (error) {
        target.stemsStatus = "failed";
        save();
        throw error;
      }
    };

    const transcriptTask = async () => {
      target.transcriptStatus = this.readTranscript(transcriptPath) ? "ready" : "running";
      save();
      try {
        await this.runJob({
          ownerType,
          ownerId,
          stage: "elevenlabs_transcript",
          complete: () => Boolean(this.readTranscript(transcriptPath)),
          run: async () => {
            const transcript = await this.elevenLabs.transcribe({ audio, projectId: transcriptProjectId, webhook: false });
            writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
          },
        });
        target.media.transcript = "transcript.json";
        target.transcriptStatus = "ready";
        save();
      } catch (error) {
        target.transcriptStatus = "failed";
        save();
        throw error;
      }
    };

    const results = await Promise.allSettled([stemsTask(), transcriptTask()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return {
      stemArchive: readFileSync(stemsPath),
      transcript: this.readTranscript(transcriptPath),
    };
  }

  materializeAnalysis(target, directory, stemArchive, transcript) {
    const stemEntries = unzipSync(stemArchive);
    const instrumental = findStem(stemEntries, "instrumental");
    const vocals = findStem(stemEntries, "vocal");
    if (!instrumental) throw new Error("instrumental_stem_missing");
    const instrumentalName = `instrumental${path.extname(instrumental[0]).toLowerCase() || ".mp3"}`;
    writeFileSync(path.join(directory, instrumentalName), instrumental[1]);
    target.media.instrumental = instrumentalName;
    if (vocals) {
      const vocalsName = `vocals${path.extname(vocals[0]).toLowerCase() || ".mp3"}`;
      writeFileSync(path.join(directory, vocalsName), vocals[1]);
      target.media.vocals = vocalsName;
    }
    target.cues = buildCues(transcript.words);
    if (!target.cues.length) throw new Error("transcript_contains_no_cues");
  }

  create({ sourceUrl, rightsAccepted }) {
    if (rightsAccepted !== true) throw new Error("rights_confirmation_required");
    this.cleanup();
    const settings = this.settingsStore.get();
    if (this.repository.list().length >= settings.maxProjects) throw new Error("project_limit_reached");
    this.assertStorageAvailable();
    const source = parsePublicYouTubeUrl(sourceUrl);
    const project = createProject(source.canonicalUrl, Date.now(), settings.projectRetentionMinutes * 60 * 1000);
    this.repository.insert(project);
    this.schedulePreparation(project.id);
    return { project: publicProject(project), token: project.token };
  }

  createFromRecommendation(recommendationId) {
    this.cleanup();
    const entry = this.recommendationStore.get(recommendationId);
    if (!entry || !this.recommendationPrepared(entry)) throw new Error("recommendation_not_found");
    const settings = this.settingsStore.get();
    if (this.repository.list().length >= settings.maxProjects) throw new Error("project_limit_reached");
    this.assertStorageAvailable();
    const project = createProject(`/recommendations/${entry.id}`, Date.now(), settings.projectRetentionMinutes * 60 * 1000);
    project.recommendationId = entry.id;
    project.title = entry.title;
    project.duration = entry.duration;
    this.repository.insert(project);
    this.schedulePreparation(project.id);
    return { project: publicProject(project), token: project.token };
  }

  get(id, token) {
    return publicProject(this.requireAuthorized(id, token));
  }

  listAdminProjects() {
    return this.repository.list()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(publicProject);
  }

  listAdminCache() {
    return this.sourceCache.list()
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map(({ videoId, sourceUrl, title, duration, createdAt, lastUsedAt, bytes }) => ({
        videoId, sourceUrl, title, duration, createdAt, lastUsedAt, bytes,
      }));
  }

  recommendationView(entry, admin = false) {
    return {
      id: entry.id,
      title: entry.title,
      state: entry.state,
      progress: entry.progress,
      duration: entry.duration,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      error: admin ? entry.error : undefined,
      sourceType: admin ? entry.sourceType || "upload" : undefined,
      sourceUrl: admin ? entry.sourceUrl || null : undefined,
      categoryId: entry.categoryId || null,
      stemsStatus: admin ? entry.stemsStatus : undefined,
      transcriptStatus: admin ? entry.transcriptStatus : undefined,
      preparedAt: admin ? entry.preparedAt : undefined,
      shareUrl: `/?recommendation=${entry.id}`,
      videoUrl: entry.state === "READY" ? `/v1/recommendations/${entry.id}/video` : null,
      posterUrl: entry.state === "READY" && entry.posterFile ? `/v1/recommendations/${entry.id}/poster?v=${entry.updatedAt}` : null,
    };
  }

  listRecommendations() {
    return this.recommendationStore.list()
      .filter((entry) => entry.state === "READY")
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((entry) => this.recommendationView(entry));
  }

  getRecommendation(id) {
    const entry = this.recommendationStore.get(id);
    if (!entry || entry.state !== "READY") throw new Error("recommendation_not_found");
    return this.recommendationView(entry);
  }

  listAdminRecommendations() {
    return this.recommendationStore.list()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((entry) => this.recommendationView(entry, true));
  }

  listRecommendationCategories() {
    return this.recommendationStore.listCategories().map((category) => ({ ...category }));
  }

  createAdminRecommendationCategory({ name }) {
    return this.recommendationStore.createCategory(name);
  }

  updateAdminRecommendationCategory(id, { name }) {
    return this.recommendationStore.updateCategory(id, name);
  }

  removeAdminRecommendationCategory(id) {
    this.recommendationStore.removeCategory(id);
  }

  setAdminRecommendationCategory(id, { categoryId = null }) {
    return this.recommendationView(this.recommendationStore.setCategory(id, categoryId), true);
  }

  maximumRecommendationBytes() {
    return this.settingsStore.get().maxSourceFileMb * 1024 * 1024;
  }

  maximumRecommendationPosterBytes() {
    return 10 * 1024 * 1024;
  }

  async updateAdminRecommendationPoster(id, { originalName, bytes }) {
    const entry = this.recommendationStore.get(id);
    if (!entry) throw new Error("recommendation_not_found");
    if (entry.state !== "READY") throw new Error("recommendation_not_ready");
    const extension = path.extname(path.basename(String(originalName || ""))).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension)) throw new Error("invalid_recommendation_poster");
    if (!bytes?.length || bytes.length > this.maximumRecommendationPosterBytes()) throw new Error("recommendation_poster_size_limit_exceeded");

    const directory = this.recommendationStore.directory(id);
    const nonce = randomUUID();
    const inputPath = path.join(directory, `poster-upload-${nonce}${extension}`);
    const normalizedPath = path.join(directory, `poster-normalized-${nonce}.jpg`);
    const posterPath = path.join(directory, "poster.jpg");
    try {
      writeFileSync(inputPath, bytes);
      await this.media.normalizePoster(inputPath, normalizedPath);
      copyFileSync(normalizedPath, posterPath);
    } catch {
      throw new Error("invalid_recommendation_poster");
    } finally {
      rmSync(inputPath, { force: true });
      rmSync(normalizedPath, { force: true });
    }
    entry.posterFile = "poster.jpg";
    entry.updatedAt = Math.max(Date.now(), Number(entry.updatedAt || 0) + 1);
    entry.bytes = directoryBytes(directory);
    this.recommendationStore.save(entry);
    return this.recommendationView(entry, true);
  }

  createAdminRecommendation({ title, originalName, bytes, categoryId = null }) {
    const upload = this.beginAdminRecommendation({ title, originalName, size: bytes?.length, categoryId });
    writeFileSync(upload.filePath, bytes);
    return this.completeAdminRecommendation(upload.recommendation.id, bytes.length);
  }

  createAdminRecommendationFromYouTube({ title, sourceUrl, categoryId = null }) {
    const source = parsePublicYouTubeUrl(sourceUrl);
    const existing = this.recommendationStore.list()
      .find((entry) => entry.sourceVideoId === source.videoId && entry.state !== "FAILED");
    if (existing) {
      if ((existing.categoryId || null) !== (categoryId || null)) this.recommendationStore.setCategory(existing.id, categoryId);
      return this.recommendationView(existing, true);
    }
    const cleanTitle = String(title || "").trim().slice(0, 160);
    const entry = this.recommendationStore.create({
      title: cleanTitle || "YouTube-видео",
      originalName: `${source.videoId}.mp4`,
      sourceType: "youtube",
      sourceUrl: source.canonicalUrl,
      sourceVideoId: source.videoId,
      useSourceTitle: !cleanTitle,
      categoryId,
    });
    this.scheduleRecommendation(entry.id);
    return this.recommendationView(entry, true);
  }

  beginAdminRecommendation({ title, originalName, size = 0, categoryId = null }) {
    const cleanTitle = String(title || "").trim().slice(0, 160);
    const cleanName = path.basename(String(originalName || "video.mp4"));
    if (!cleanTitle) throw new Error("invalid_recommendation_title");
    if (!/\.mp4$/i.test(cleanName)) throw new Error("invalid_recommendation_file");
    if (size < 0 || size > this.maximumRecommendationBytes()) throw new Error("source_size_limit_exceeded");
    this.assertStorageAvailable(size);
    const entry = this.recommendationStore.create({ title: cleanTitle, originalName: cleanName, categoryId });
    return { recommendation: this.recommendationView(entry, true), filePath: this.recommendationStore.sourcePath(entry.id) };
  }

  completeAdminRecommendation(id, size) {
    const entry = this.recommendationStore.get(id);
    if (!entry) throw new Error("recommendation_not_found");
    if (!size || size > this.maximumRecommendationBytes()) {
      this.recommendationStore.remove(id);
      throw new Error("source_size_limit_exceeded");
    }
    try {
      this.assertStorageAvailable();
    } catch (error) {
      this.recommendationStore.remove(id);
      throw error;
    }
    this.scheduleRecommendation(entry.id);
    return this.recommendationView(entry, true);
  }

  abortAdminRecommendation(id) {
    this.recommendationStore.remove(id);
  }

  removeAdminRecommendation(id) {
    if (!this.recommendationStore.get(id)) throw new Error("recommendation_not_found");
    this.recommendationStore.remove(id);
    this.jobRepository.removeOwner("recommendation", id);
  }

  recommendationAsset(id, kind) {
    return this.recommendationStore.asset(id, kind);
  }

  recoverRecommendations() {
    for (const entry of this.recommendationStore.list()) {
      const sourcePath = path.join(this.recommendationStore.directory(entry.id), entry.sourceFile || "source.mp4");
      const videoPath = entry.videoFile ? path.join(this.recommendationStore.directory(entry.id), entry.videoFile) : "";
      if (entry.state === "READY" && !this.recommendationPrepared(entry) && existsSync(videoPath)) {
        entry.state = "PROCESSING";
        entry.progress = 40;
        entry.error = null;
        this.recommendationStore.save(entry);
      }
      if (entry.state === "PROCESSING" && (existsSync(sourcePath) || existsSync(videoPath) || entry.sourceUrl)) this.scheduleRecommendation(entry.id);
    }
  }

  recommendationPrepared(entry) {
    if (!entry || entry.state !== "READY" || !entry.videoFile || !entry.media?.instrumental || !entry.cues?.length) return false;
    const directory = this.recommendationStore.directory(entry.id);
    return existsSync(path.join(directory, safeAssetName(entry.videoFile)))
      && existsSync(path.join(directory, safeAssetName(entry.media.instrumental)));
  }

  scheduleRecommendation(id) {
    void this.queue.add(() => this.processRecommendation(id));
  }

  async processRecommendation(id) {
    const entry = this.recommendationStore.get(id);
    if (!entry || entry.state !== "PROCESSING") return;
    const directory = this.recommendationStore.directory(id);
    const sourcePath = path.join(directory, entry.sourceFile || "source.mp4");
    const videoPath = path.join(directory, "video.mp4");
    const posterPath = path.join(directory, "poster.jpg");
    try {
      let inspection;
      if (entry.videoFile && existsSync(videoPath) && !existsSync(sourcePath)) {
        inspection = await this.media.inspect(videoPath);
      } else {
        if (!existsSync(sourcePath) && entry.sourceType === "youtube" && entry.sourceUrl && entry.sourceVideoId) {
          const settings = this.settingsStore.get();
          const cached = this.sourceCache.get(entry.sourceVideoId, settings.cacheRetentionHours * 60 * 60 * 1000);
          entry.progress = 10;
          this.recommendationStore.save(entry);
          if (cached) {
            cloneFile(path.join(cached.directory, cached.media.prepared), sourcePath);
            if (entry.useSourceTitle) entry.title = String(cached.title || "YouTube-видео").slice(0, 160);
            entry.duration = cached.duration;
          } else {
            const metadata = await this.youtube.inspect(entry.sourceUrl);
            if (metadata.duration > settings.maxVideoDurationMinutes * 60) throw new Error("source_duration_limit_exceeded");
            if (entry.useSourceTitle) entry.title = String(metadata.title || "YouTube-видео").slice(0, 160);
            entry.duration = metadata.duration;
            entry.progress = 20;
            this.recommendationStore.save(entry);
            const downloadedPath = await this.youtube.download(entry.sourceUrl, directory, `recommendation-${id}`, this.maximumRecommendationBytes());
            if (statSync(downloadedPath).size > this.maximumRecommendationBytes()) throw new Error("source_size_limit_exceeded");
            if (path.resolve(downloadedPath) !== path.resolve(sourcePath)) {
              copyFileSync(downloadedPath, sourcePath);
              rmSync(downloadedPath, { force: true });
            }
          }
          this.assertStorageAvailable();
        }
        entry.progress = Math.max(15, entry.progress);
        this.recommendationStore.save(entry);
        inspection = await this.media.inspect(sourcePath);
        if (inspection.duration > this.settingsStore.get().maxVideoDurationMinutes * 60) throw new Error("source_duration_limit_exceeded");
        entry.progress = 30;
        this.recommendationStore.save(entry);
        await this.media.normalizeVideo(sourcePath, videoPath);
        rmSync(sourcePath, { force: true });
        entry.sourceFile = null;
        entry.videoFile = "video.mp4";
      }
      if (inspection.duration > this.settingsStore.get().maxVideoDurationMinutes * 60) throw new Error("source_duration_limit_exceeded");
      if (!entry.posterFile || !existsSync(posterPath)) try {
        await this.media.createVideoPoster(videoPath, posterPath);
        entry.posterFile = "poster.jpg";
      } catch {
        entry.posterFile = null;
      }
      entry.duration = inspection.duration;
      entry.width = inspection.width;
      entry.height = inspection.height;
      entry.progress = 40;
      entry.media = this.recoverMedia(directory, entry.media);
      entry.cues = [];
      this.recommendationStore.save(entry);

      if (this.pipelineMode === "stub") {
        const instrumentalPath = path.join(directory, "instrumental.wav");
        await this.media.extractAudio(videoPath, instrumentalPath);
        entry.media.instrumental = "instrumental.wav";
        entry.cues = buildCues([
          { type: "word", text: "Тестовая", start: 0.4, end: 0.8 },
          { type: "word", text: "реплика.", start: 0.82, end: 1.4 },
        ]);
        entry.stemsStatus = "ready";
        entry.transcriptStatus = "ready";
      } else {
        if (this.pipelineMode !== "real") throw new Error("pipeline_mode_not_supported");
        const masterPath = path.join(directory, "master.wav");
        if (!existsSync(masterPath)) await this.media.extractAudio(videoPath, masterPath);
        entry.media.master = "master.wav";
        entry.progress = 50;
        this.recommendationStore.save(entry);
        const { stemArchive, transcript } = await this.analyzeAudio(entry, {
          ownerType: "recommendation",
          ownerId: entry.id,
          directory,
          transcriptProjectId: `recommendation-${entry.id}`,
          save: () => this.recommendationStore.save(entry),
        });
        entry.progress = 80;
        this.materializeAnalysis(entry, directory, stemArchive, transcript);
      }

      entry.progress = 95;
      this.recommendationStore.save(entry);
      entry.bytes = directoryBytes(directory);
      this.assertStorageAvailable();
      entry.state = "READY";
      entry.progress = 100;
      entry.updatedAt = Date.now();
      entry.preparedAt = entry.updatedAt;
      entry.error = null;
      entry.errorDetail = null;
      entry.useSourceTitle = false;
      this.recommendationStore.save(entry);
    } catch (error) {
      entry.state = "FAILED";
      entry.progress = 0;
      entry.updatedAt = Date.now();
      if (entry.stemsStatus === "running") entry.stemsStatus = "failed";
      if (entry.transcriptStatus === "running") entry.transcriptStatus = "failed";
      recordPipelineFailure(entry, "recommendation", entry.id, error);
      this.recommendationStore.save(entry);
    }
  }

  runtimeStats() {
    const jobs = this.jobRepository.stats();
    return {
      status: jobs.deadLetter ? "attention" : "ready",
      pipelineMode: this.pipelineMode,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      queue: this.queue.stats?.() ?? { concurrency: 1, running: this.runningProjects.size, pending: 0 },
      jobs,
      activeProjects: this.runningProjects.size,
      activeSources: this.sourcePreparations.size,
      failedProjects: this.repository.list().filter((project) => project.state === "FAILED").length,
      failedRecommendations: this.recommendationStore.list().filter((entry) => entry.state === "FAILED").length,
    };
  }

  adminSettings() {
    return {
      settings: this.settingsStore.get(),
      limits: settingLimits(),
      storage: this.storageStats(),
      runtime: this.runtimeStats(),
    };
  }

  updateAdminSettings(input) {
    const settings = this.settingsStore.update(input);
    this.queue.setConcurrency?.(settings.pipelineConcurrency);
    this.applyProjectRetention();
    this.cleanup();
    return this.adminSettings();
  }

  maximumTakeBytes() {
    return this.settingsStore.get().maxTakeFileMb * 1024 * 1024;
  }

  maximumProjectCreationsPerMinute() {
    return this.settingsStore.get().maxProjectCreationsPerMinute;
  }

  applyProjectRetention() {
    const retentionMs = this.settingsStore.get().projectRetentionMinutes * 60 * 1000;
    for (const project of this.repository.list()) {
      const activityAt = Number(project.lastHeartbeatAt || project.updatedAt || project.createdAt);
      project.sourceExpiresAt = activityAt + retentionMs;
      project.workingExpiresAt = activityAt + retentionMs;
      this.repository.save(project);
    }
  }

  migrateReusableProjectsToCache() {
    for (const project of this.repository.list().sort((left, right) => left.updatedAt - right.updatedAt)) {
      if (!project.cues?.length || !project.media?.prepared || !project.media?.instrumental) continue;
      const directory = this.repository.directory(project.id);
      if (!existsSync(path.join(directory, project.media.prepared)) || !existsSync(path.join(directory, project.media.instrumental))) continue;
      try {
        this.cachePreparedProject(project, directory);
      } catch {
        // A damaged legacy project is ignored and will expire normally.
      }
    }
  }

  storageStats() {
    const seen = new Set();
    const cacheBytes = directoryBytes(this.sourceCache.rootDirectory, seen);
    const recommendationBytes = directoryBytes(this.recommendationStore.rootDirectory, seen);
    let projectBytes = 0;
    for (const project of this.repository.list()) projectBytes += directoryBytes(this.repository.directory(project.id), seen);
    const disk = filesystemStats(this.repository.rootDirectory);
    return {
      projectCount: this.repository.list().length,
      cacheCount: this.sourceCache.list().length,
      recommendationCount: this.recommendationStore.list().length,
      projectBytes,
      cacheBytes,
      recommendationBytes,
      totalBytes: projectBytes + cacheBytes + recommendationBytes,
      diskFreeBytes: disk?.freeBytes ?? null,
      diskTotalBytes: disk?.totalBytes ?? null,
    };
  }

  assertStorageAvailable(additionalBytes = 0) {
    const settings = this.settingsStore.get();
    const storage = this.storageStats();
    if (storage.totalBytes + additionalBytes > settings.maxTotalStorageGb * 1024 ** 3) throw new Error("storage_limit_reached");
    if (storage.diskFreeBytes !== null && storage.diskFreeBytes - additionalBytes < settings.minFreeStorageGb * 1024 ** 3) {
      throw new Error("disk_space_low");
    }
    return storage;
  }

  dependencyStatus() {
    const settings = this.settingsStore.get();
    const disk = filesystemStats(this.repository.rootDirectory);
    const diskReady = Boolean(disk) && disk.freeBytes >= settings.minFreeStorageGb * 1024 ** 3;
    const checks = [
      {
        name: "pipeline_mode",
        available: ["stub", "real"].includes(this.pipelineMode),
        required: true,
        reason: ["stub", "real"].includes(this.pipelineMode) ? null : "invalid_value",
      },
      checkExecutable("ffmpeg", this.media?.ffmpeg),
      checkExecutable("ffprobe", this.media?.ffprobe),
      checkDirectory("project_root", this.repository.rootDirectory, true),
      checkDirectory("cache_root", this.sourceCache?.rootDirectory, true),
      checkDirectory("recommendation_root", this.recommendationStore?.rootDirectory, true),
      checkDirectory("job_root", this.jobRepository?.rootDirectory, true),
      {
        name: "disk_free_space",
        available: diskReady,
        required: true,
        reason: disk ? diskReady ? null : "low_disk_space" : "disk_stats_unavailable",
      },
    ];

    if (this.pipelineMode === "real") {
      checks.push(checkExecutable("yt_dlp", this.youtube?.executable));
      checks.push(checkSecret("elevenlabs_api_key", this.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY));
    }

    const missing = checks.filter((entry) => entry.required && !entry.available).map((entry) => entry.name);
    const degraded = checks.filter((entry) => !entry.available).map((entry) => entry.name);
    return {
      status: missing.length ? "not_ready" : "ready",
      mode: this.pipelineMode,
      checks,
      missing,
      degraded,
    };
  }

  verifyRuntimeDependencies() {
    const dependencyStatus = this.dependencyStatus();
    if (dependencyStatus.status !== "ready") {
      throw new Error(`runtime_dependency_check_failed:${dependencyStatus.missing.join(",")}`);
    }
    return dependencyStatus;
  }

  health() {
    const dependencies = this.dependencyStatus();
    return {
      status: dependencies.status === "ready" ? "ready" : "degraded",
      service: "dubroom-server",
      version: "3.2",
      runtime: this.runtimeStats(),
      dependencies: {
        status: dependencies.status,
        mode: dependencies.mode,
        checks: dependencies.checks.map(({ name, available, required, reason }) => ({ name, available, required, reason })),
        missing: dependencies.missing,
        degraded: dependencies.degraded,
      },
    };
  }

  shutdown() {
    return this.queue.close?.() ?? Promise.resolve();
  }

  removeAdminProject(id) {
    if (!this.repository.get(id)) throw new Error("project_not_found");
    this.repository.delete(id);
    this.jobRepository.removeOwner("project", id);
  }

  removeAdminCache(videoId) {
    if (!this.sourceCache.read(videoId)) throw new Error("cache_not_found");
    this.sourceCache.remove(videoId);
  }

  clearAdminCache() {
    this.sourceCache.clear();
  }

  listAdminDeadLetters() {
    return this.jobRepository.listDeadLetters().map((job) => {
      const owner = job.ownerType === "project" ? this.repository.get(job.ownerId) : this.recommendationStore.get(job.ownerId);
      return {
        id: job.id,
        ownerType: job.ownerType,
        ownerId: job.ownerId,
        ownerTitle: owner?.title || "Удалённый объект",
        ownerState: owner?.state || "MISSING",
        stage: job.stage,
        attempts: job.attempts,
        failedAt: job.lastFailedAt || job.updatedAt,
        error: job.error,
      };
    });
  }

  retryAdminJob(id) {
    const job = this.jobRepository.getById(id);
    if (!job) throw new Error("job_not_found");
    if (!["FAILED", "DEAD_LETTER"].includes(job.state)) throw new Error("job_not_failed");
    if (job.ownerType === "project") return { jobId: id, ownerType: job.ownerType, project: this.retryAdminProject(job.ownerId) };
    if (job.ownerType === "recommendation") return { jobId: id, ownerType: job.ownerType, recommendation: this.retryAdminRecommendation(job.ownerId) };
    throw new Error("job_owner_not_supported");
  }

  retryAdminProject(id) {
    const project = this.repository.get(id);
    if (!project) throw new Error("project_not_found");
    if (project.state !== "FAILED") throw new Error("project_not_failed");
    this.jobRepository.resetOwnerFailures("project", id);
    const directory = this.repository.directory(id);
    const hasPreparedProject = project.cues?.length
      && project.media?.prepared
      && project.media?.instrumental
      && existsSync(path.join(directory, project.media.prepared))
      && existsSync(path.join(directory, project.media.instrumental));
    if (hasPreparedProject) {
      const completeTakes = project.cues.every((cue) => project.takes?.[cue.id]);
      recoverProject(project, Object.keys(project.takes || {}).length ? "RECORDING" : "READY_TO_DUB");
      project.progress = 100;
      touchProject(project, Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
      this.repository.save(project);
      if (completeTakes) return this.finalize(id, project.token);
      return publicProject(project);
    }
    project.progress = 0;
    project.stemsStatus = "pending";
    project.transcriptStatus = "pending";
    project.cues = [];
    project.takes = {};
    project.media = this.recoverMedia(directory, project.media);
    recoverProject(project, "CREATED");
    touchProject(project, Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
    this.repository.save(project);
    this.schedulePreparation(id);
    return publicProject(project);
  }

  retryAdminRecommendation(id) {
    const entry = this.recommendationStore.get(id);
    if (!entry) throw new Error("recommendation_not_found");
    if (entry.state !== "FAILED") throw new Error("recommendation_not_failed");
    const directory = this.recommendationStore.directory(id);
    const stemsPath = path.join(directory, "stems.zip");
    const transcriptPath = path.join(directory, "transcript.json");
    this.jobRepository.resetOwnerFailures("recommendation", id);
    entry.media = this.recoverMedia(directory, entry.media);
    entry.stemsStatus = this.validStemArchive(stemsPath) ? "ready" : "pending";
    entry.transcriptStatus = this.readTranscript(transcriptPath) ? "ready" : "pending";
    entry.state = "PROCESSING";
    entry.progress = entry.videoFile && existsSync(path.join(directory, entry.videoFile)) ? 40 : 5;
    entry.error = null;
    entry.errorDetail = null;
    entry.updatedAt = Date.now();
    this.recommendationStore.save(entry);
    this.scheduleRecommendation(id);
    return this.recommendationView(entry, true);
  }

  recoverInterruptedProjects() {
    for (const project of this.repository.list()) {
      if (project.state === "CREATED") {
        this.schedulePreparation(project.id);
        continue;
      }
      if (["INGESTING", "EXTRACTING_AUDIO", "ANALYZING", "BUILDING_CUES"].includes(project.state)) {
        project.progress = 0;
        project.stemsStatus = "pending";
        project.transcriptStatus = "pending";
        project.cues = [];
        project.takes = {};
        project.media = this.recoverMedia(this.repository.directory(project.id), project.media);
        recoverProject(project, "CREATED");
        this.repository.save(project);
        this.schedulePreparation(project.id);
        continue;
      }
      if (project.state === "FINALIZING") {
        const canRender = project.cues?.length
          && project.cues.every((cue) => project.takes?.[cue.id])
          && project.media?.prepared
          && project.media?.instrumental;
        if (canRender) void this.queue.add(() => this.render(project.id));
        else {
          recoverProject(project, "FAILED");
          project.error = "interrupted_project_incomplete";
          this.repository.save(project);
        }
      }
    }
  }

  heartbeat(id, token) {
    const project = touchProject(this.requireAuthorized(id, token), Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
    this.repository.save(project);
    return publicProject(project);
  }

  projectEvents(id, token) {
    const project = this.requireAuthorized(id, token);
    return project.events.map((event) => ({ ...event }));
  }

  remove(id, token) {
    this.requireAuthorized(id, token);
    this.repository.delete(id);
    this.jobRepository.removeOwner("project", id);
  }

  requireAuthorized(id, token) {
    const project = this.repository.get(id);
    if (!project) throw new Error("project_not_found");
    if (!token || token !== project.token) throw new Error("project_unauthorized");
    return project;
  }

  signedMediaUrl(project, pathname) {
    return createSignedProjectUrl(project, pathname, { ttlSeconds: this.mediaUrlTtlSeconds });
  }

  requireMediaAuthorized(id, token, signed = {}) {
    const project = this.repository.get(id);
    if (!project) throw new Error("project_not_found");
    if (token && token === project.token) return project;
    if (signed.pathname && verifySignedProjectUrl(project, signed.pathname, signed)) return project;
    throw new Error("project_unauthorized");
  }

  schedulePreparation(id, delayMs = 0) {
    if (delayMs > 0) {
      setTimeout(() => this.schedulePreparation(id), delayMs);
      return;
    }
    if (this.runningProjects.has(id)) return;
    const project = this.repository.get(id);
    if (!project) return;
    this.runningProjects.add(id);
    const activeSourcePreparation = this.sourcePreparations.get(project.sourceUrl);
    if (activeSourcePreparation) {
      void activeSourcePreparation
        .catch(() => undefined)
        .then(() => this.queue.add(() => this.prepare(id)))
        .finally(() => this.runningProjects.delete(id))
        .catch(() => undefined);
      return;
    }
    const preparation = this.queue.add(() => this.prepare(id));
    this.sourcePreparations.set(project.sourceUrl, preparation);
    const releasePreparation = () => {
      this.runningProjects.delete(id);
      if (this.sourcePreparations.get(project.sourceUrl) === preparation) this.sourcePreparations.delete(project.sourceUrl);
    };
    void preparation.then(releasePreparation, releasePreparation);
  }

  update(project, progress) {
    project.progress = progress;
    touchProject(project, Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
    this.repository.save(project);
  }

  reusableProject(project) {
    const now = Date.now();
    return this.repository.list()
      .filter((candidate) => candidate.id !== project.id
        && candidate.sourceUrl === project.sourceUrl
        && candidate.sourceExpiresAt > now
        && ["READY_TO_DUB", "RECORDING", "FINALIZING", "READY", "FAILED"].includes(candidate.state)
        && candidate.cues?.length
        && candidate.media?.prepared
        && candidate.media?.instrumental)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find((candidate) => existsSync(path.join(this.repository.directory(candidate.id), candidate.media.prepared))
        && existsSync(path.join(this.repository.directory(candidate.id), candidate.media.instrumental))) ?? null;
  }

  cachedSource(project) {
    const retentionMs = this.settingsStore.get().cacheRetentionHours * 60 * 60 * 1000;
    const source = parsePublicYouTubeUrl(project.sourceUrl);
    return this.sourceCache.get(source.videoId, retentionMs);
  }

  cachePreparedProject(project, directory) {
    if (project.recommendationId) return;
    const source = parsePublicYouTubeUrl(project.sourceUrl);
    this.sourceCache.put(source.videoId, directory, project);
    const settings = this.settingsStore.get();
    this.sourceCache.cleanup(
      settings.cacheRetentionHours * 60 * 60 * 1000,
      settings.maxCacheStorageGb * 1024 ** 3,
    );
  }

  reusePreparedProject(project, directory, sourceProject, sourceDirectory = this.repository.directory(sourceProject.id), reusedFromProjectId = sourceProject.id) {
    transitionProject(project, "INGESTING");
    this.update(project, 20);
    project.title = sourceProject.title;
    project.duration = sourceProject.duration;
    project.media = {};
    for (const key of reusableMediaKeys) {
      const fileName = sourceProject.media?.[key];
      if (!fileName) continue;
      const sourcePath = path.join(sourceDirectory, safeAssetName(fileName));
      if (!existsSync(sourcePath)) continue;
      const targetName = safeAssetName(fileName);
      cloneFile(sourcePath, path.join(directory, targetName));
      project.media[key] = targetName;
    }
    if (!project.media.prepared || !project.media.instrumental) throw new Error("cached_project_assets_missing");
    transitionProject(project, "EXTRACTING_AUDIO");
    this.update(project, 45);
    transitionProject(project, "ANALYZING");
    project.stemsStatus = "ready";
    project.transcriptStatus = "ready";
    this.update(project, 80);
    transitionProject(project, "BUILDING_CUES");
    project.cues = sourceProject.cues.map((cue) => ({ ...cue }));
    project.reusedFromProjectId = reusedFromProjectId;
    this.update(project, 95);
    transitionProject(project, "READY_TO_DUB");
    this.update(project, 100);
  }

  async prepare(id) {
    const project = this.repository.get(id);
    if (!project || project.state !== "CREATED") return;
    const directory = this.repository.directory(project.id);
    try {
      if (project.recommendationId) {
        await this.prepareRecommendationProject(project, directory);
        return;
      }
      const cachedSource = this.cachedSource(project);
      if (cachedSource) {
        this.reusePreparedProject(project, directory, cachedSource, cachedSource.directory, null);
        return;
      }
      const sourceProject = this.reusableProject(project);
      if (sourceProject) {
        this.reusePreparedProject(project, directory, sourceProject);
        this.cachePreparedProject(project, directory);
        return;
      }
      if (this.pipelineMode === "stub") {
        await this.prepareStub(project, directory);
        return;
      }
      if (this.pipelineMode !== "real") throw new Error("pipeline_mode_not_supported");
      transitionProject(project, "INGESTING");
      this.update(project, 5);
      const settings = this.settingsStore.get();
      const maximumSourceBytes = settings.maxSourceFileMb * 1024 * 1024;
      const sourcePath = path.join(directory, "source.mp4");
      const preparedPath = path.join(directory, "prepared.mp4");
      const masterPath = path.join(directory, "master.wav");
      project.media = this.recoverMedia(directory, project.media);
      await this.runJob({
        ownerType: "project",
        ownerId: project.id,
        stage: "youtube_download",
        complete: () => existsSync(sourcePath) || existsSync(preparedPath),
        run: async () => {
          const metadata = await this.youtube.inspect(project.sourceUrl);
          if (metadata.duration > settings.maxVideoDurationMinutes * 60) throw new Error("source_duration_limit_exceeded");
          project.title = metadata.title;
          project.duration = metadata.duration;
          this.update(project, 10);
          const downloadedPath = await this.youtube.download(project.sourceUrl, directory, project.id, maximumSourceBytes);
          if (statSync(downloadedPath).size > maximumSourceBytes) throw new Error("source_size_limit_exceeded");
          if (path.resolve(downloadedPath) !== path.resolve(sourcePath)) {
            copyFileSync(downloadedPath, sourcePath);
            rmSync(downloadedPath, { force: true });
          }
        },
      });
      if (existsSync(sourcePath)) project.media.source = "source.mp4";
      this.update(project, 25);

      transitionProject(project, "EXTRACTING_AUDIO");
      this.update(project, 30);
      await this.runJob({
        ownerType: "project",
        ownerId: project.id,
        stage: "prepare_video",
        complete: () => existsSync(preparedPath),
        run: async () => {
          const inspection = await this.media.inspect(sourcePath);
          project.duration = inspection.duration;
          if (inspection.canCopyVideoToMp4 && inspection.videoCodec === "h264") copyFileSync(sourcePath, preparedPath);
          else await this.media.normalizeVideo(sourcePath, preparedPath);
        },
      });
      project.media.prepared = "prepared.mp4";
      if (!project.duration) project.duration = (await this.media.inspect(preparedPath)).duration;
      await this.runJob({
        ownerType: "project",
        ownerId: project.id,
        stage: "extract_master",
        complete: () => existsSync(masterPath),
        run: () => this.media.extractAudio(preparedPath, masterPath),
      });
      project.media.master = "master.wav";
      this.update(project, 40);

      transitionProject(project, "ANALYZING");
      this.update(project, 45);
      const { stemArchive, transcript } = await this.analyzeAudio(project, {
        ownerType: "project",
        ownerId: project.id,
        directory,
        transcriptProjectId: project.id,
        save: () => this.repository.save(project),
      });
      this.update(project, 78);
      this.materializeAnalysis(project, directory, stemArchive, transcript);

      transitionProject(project, "BUILDING_CUES");
      this.update(project, 95);
      transitionProject(project, "READY_TO_DUB");
      this.update(project, 100);
      this.cachePreparedProject(project, directory);
    } catch (error) {
      const nextAttemptAt = scheduledRetryAt(error);
      if (nextAttemptAt) {
        project.media = this.recoverMedia(directory, project.media);
        recoverProject(project, "CREATED");
        this.repository.save(project);
        this.schedulePreparation(project.id, Math.max(1, nextAttemptAt - Date.now()));
        return;
      }
      recordPipelineFailure(project, "project", project.id, error);
      project.stemsStatus = project.stemsStatus === "running" ? "failed" : project.stemsStatus;
      project.transcriptStatus = project.transcriptStatus === "running" ? "failed" : project.transcriptStatus;
      if (project.state !== "FAILED") transitionProject(project, "FAILED");
      this.repository.save(project);
    }
  }

  async prepareRecommendationProject(project, directory) {
    const recommendation = this.recommendationStore.get(project.recommendationId);
    if (!recommendation || !this.recommendationPrepared(recommendation)) throw new Error("recommendation_not_found");
    const sourceProject = {
      title: recommendation.title,
      duration: recommendation.duration,
      media: {
        ...recommendation.media,
        source: recommendation.videoFile,
        prepared: recommendation.videoFile,
      },
      cues: recommendation.cues,
    };
    this.reusePreparedProject(
      project,
      directory,
      sourceProject,
      this.recommendationStore.directory(recommendation.id),
      null,
    );
  }

  async prepareStub(project, directory) {
    const sourceFixture = process.env.DUBROOM_STUB_VIDEO;
    transitionProject(project, "INGESTING");
    this.update(project, 20);
    const preparedPath = path.join(directory, "prepared.mp4");
    if (sourceFixture && existsSync(sourceFixture)) copyFileSync(sourceFixture, preparedPath);
    else await this.media.createStubVideo(preparedPath, 4);
    project.media.source = "prepared.mp4";
    project.media.prepared = "prepared.mp4";
    transitionProject(project, "EXTRACTING_AUDIO");
    this.update(project, 40);
    const instrumentalPath = path.join(directory, "instrumental.wav");
    await this.media.extractAudio(preparedPath, instrumentalPath);
    project.media.instrumental = "instrumental.wav";
    transitionProject(project, "ANALYZING");
    project.stemsStatus = "ready";
    project.transcriptStatus = "ready";
    this.update(project, 75);
    transitionProject(project, "BUILDING_CUES");
    project.title = "Локальный тест";
    project.duration = 4;
    project.cues = buildCues([
      { type: "word", text: "Тестовая", start: 0.4, end: 0.8 },
      { type: "word", text: "реплика.", start: 0.82, end: 1.4 },
      { type: "word", text: "Вторая", start: 2.2, end: 2.6 },
      { type: "word", text: "реплика.", start: 2.62, end: 3.3 },
    ]);
    transitionProject(project, "READY_TO_DUB");
    this.update(project, 100);
    this.cachePreparedProject(project, directory);
  }

  manifest(id, token) {
    const project = this.requireAuthorized(id, token);
    if (!["READY_TO_DUB", "RECORDING", "FINALIZING", "READY"].includes(project.state)) throw new Error("manifest_not_ready");
    const mediaPath = (kind) => `/v1/projects/${project.id}/media/${kind}`;
    const takePath = (cueId) => `/v1/projects/${project.id}/takes/${encodeURIComponent(cueId)}`;
    const resultPath = `/v1/projects/${project.id}/result/file`;
    return {
      projectId: project.id,
      revision: project.manifestRevision || 1,
      title: project.title,
      duration: project.duration,
      cues: project.cues,
      recordedCueIds: Object.keys(project.takes || {}),
      takeUrls: Object.fromEntries(Object.keys(project.takes || {}).map((cueId) => [
        cueId,
        this.signedMediaUrl(project, takePath(cueId)),
      ])),
      videoUrl: this.signedMediaUrl(project, mediaPath("prepared")),
      instrumentalUrl: project.media.instrumental ? this.signedMediaUrl(project, mediaPath("instrumental")) : null,
      vocalsUrl: project.media.vocals ? this.signedMediaUrl(project, mediaPath("vocals")) : null,
      resultUrl: project.media.result ? this.signedMediaUrl(project, resultPath) : null,
    };
  }

  asset(id, token, kind, signed = {}) {
    const project = this.requireMediaAuthorized(id, token, signed);
    const allowed = { prepared: project.media.prepared, instrumental: project.media.instrumental, vocals: project.media.vocals, result: project.media.result };
    const name = allowed[kind];
    if (!name) throw new Error("asset_not_found");
    const filePath = path.join(this.repository.directory(id), safeAssetName(name));
    if (!existsSync(filePath)) throw new Error("asset_not_found");
    return { filePath, contentType: mimeType(filePath), stat: statSync(filePath) };
  }

  takeAsset(id, token, cueId, signed = {}) {
    const project = this.requireMediaAuthorized(id, token, signed);
    if (!project.cues.some((cue) => cue.id === cueId)) throw new Error("cue_not_found");
    const take = project.takes[cueId];
    if (!take) throw new Error("asset_not_found");
    const filePath = path.join(this.repository.directory(id), take.fileName);
    if (!existsSync(filePath)) throw new Error("asset_not_found");
    return { filePath, contentType: mimeType(filePath), stat: statSync(filePath) };
  }

  resultStatus(id, token) {
    const project = this.requireAuthorized(id, token);
    const pathname = `/v1/projects/${project.id}/result/file`;
    return {
      project: publicProject(project),
      resultUrl: project.state === "READY" && project.media.result ? this.signedMediaUrl(project, pathname) : null,
    };
  }

  takePath(project, cueId) {
    if (!project.cues.some((cue) => cue.id === cueId)) throw new Error("cue_not_found");
    const directory = path.join(this.repository.directory(project.id), "takes");
    mkdirSync(directory, { recursive: true });
    return path.join(directory, `${safeAssetName(cueId)}.webm`);
  }

  saveTake(id, token, cueId, bytes, metadata = {}) {
    const project = this.requireAuthorized(id, token);
    if (!["READY_TO_DUB", "RECORDING"].includes(project.state)) throw new Error("project_not_recordable");
    if (bytes.length <= 0 || bytes.length > this.maximumTakeBytes()) throw new Error("invalid_take_size");
    this.assertStorageAvailable(bytes.length);
    const revision = Number(metadata.revision || project.manifestRevision || 1);
    if (revision !== (project.manifestRevision || 1)) throw new Error("manifest_revision_mismatch");
    const target = this.takePath(project, cueId);
    writeFileSync(target, bytes);
    project.takes[cueId] = {
      fileName: path.relative(this.repository.directory(id), target).replace(/\\/g, "/"),
      size: bytes.length,
      duration: Number(metadata.duration) || null,
      revision,
      updatedAt: Date.now(),
    };
    if (project.state === "READY_TO_DUB") transitionProject(project, "RECORDING");
    touchProject(project, Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
    this.repository.save(project);
    return publicProject(project);
  }

  deleteTake(id, token, cueId) {
    const project = this.requireAuthorized(id, token);
    const take = project.takes[cueId];
    if (take) rmSync(path.join(this.repository.directory(id), take.fileName), { force: true });
    delete project.takes[cueId];
    touchProject(project, Date.now(), this.settingsStore.get().projectRetentionMinutes * 60 * 1000);
    this.repository.save(project);
    return publicProject(project);
  }

  finalize(id, token) {
    const project = this.requireAuthorized(id, token);
    if (project.state === "FINALIZING" || project.state === "READY") return publicProject(project);
    if (project.state !== "RECORDING") throw new Error("project_not_ready_to_finalize");
    if (project.cues.some((cue) => !project.takes[cue.id])) throw new Error("missing_takes");
    if (Object.values(project.takes).some((take) => take.revision !== (project.manifestRevision || 1))) throw new Error("manifest_revision_mismatch");
    transitionProject(project, "FINALIZING");
    project.progress = 1;
    this.repository.save(project);
    void this.queue.add(() => this.render(id));
    return publicProject(project);
  }

  async render(id) {
    const project = this.repository.get(id);
    if (!project || project.state !== "FINALIZING") return;
    try {
      const directory = this.repository.directory(id);
      const takePaths = new Map(project.cues.map((cue) => [cue.id, path.join(directory, project.takes[cue.id].fileName)]));
      const resultPath = path.join(directory, "result.mp4");
      await this.runJob({
        ownerType: "project",
        ownerId: project.id,
        stage: "final_render",
        complete: () => existsSync(resultPath) && statSync(resultPath).size > 0,
        run: () => this.media.assembleDub({
          videoPath: path.join(directory, project.media.prepared),
          instrumentalPath: path.join(directory, project.media.instrumental),
          cues: project.cues,
          takePaths,
          duration: project.duration,
          outputPath: resultPath,
        }),
      });
      project.media.result = "result.mp4";
      try {
        this.assertStorageAvailable();
      } catch (error) {
        rmSync(resultPath, { force: true });
        project.media.result = null;
        throw error;
      }
      const expiresAt = Date.now() + this.settingsStore.get().projectRetentionMinutes * 60 * 1000;
      project.sourceExpiresAt = expiresAt;
      project.workingExpiresAt = expiresAt;
      transitionProject(project, "READY");
      project.progress = 100;
      project.error = null;
      project.errorDetail = null;
      this.repository.save(project);
    } catch (error) {
      const nextAttemptAt = scheduledRetryAt(error);
      if (nextAttemptAt) {
        project.error = null;
        project.errorDetail = null;
        this.repository.save(project);
        setTimeout(() => void this.queue.add(() => this.render(id)).catch(() => undefined), Math.max(1, nextAttemptAt - Date.now()));
        return;
      }
      recordPipelineFailure(project, "render", project.id, error);
      transitionProject(project, "FAILED");
      this.repository.save(project);
    }
  }

  cleanup(now = Date.now()) {
    for (const project of this.repository.list()) {
      const processing = ["INGESTING", "EXTRACTING_AUDIO", "ANALYZING", "BUILDING_CUES", "FINALIZING"].includes(project.state);
      if (!processing && now >= project.workingExpiresAt) {
        this.repository.delete(project.id);
        this.jobRepository.removeOwner("project", project.id);
      }
    }
    const settings = this.settingsStore.get();
    this.sourceCache.cleanup(
      settings.cacheRetentionHours * 60 * 60 * 1000,
      settings.maxCacheStorageGb * 1024 ** 3,
      now,
    );
  }
}
