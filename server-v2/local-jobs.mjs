import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const jobStates = new Set(["PENDING", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "DEAD_LETTER"]);

function jobId(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

function normalizeJob(job) {
  if (!job || typeof job !== "object" || !job.key || !job.ownerId || !job.stage) return null;
  job.id = jobId(job.key);
  job.state = jobStates.has(job.state) ? job.state : "PENDING";
  job.attempts = Math.max(0, Number(job.attempts) || 0);
  job.createdAt = Number(job.createdAt) || Date.now();
  job.updatedAt = Number(job.updatedAt) || job.createdAt;
  job.startedAt = Number(job.startedAt) || null;
  job.completedAt = Number(job.completedAt) || null;
  job.nextAttemptAt = Number(job.nextAttemptAt) || null;
  job.lastFailedAt = Number(job.lastFailedAt) || null;
  job.error = typeof job.error === "string" ? job.error : null;
  return job;
}

export class LocalJobRepository {
  constructor(dataRoot) {
    this.rootDirectory = path.join(path.resolve(dataRoot), "jobs");
    mkdirSync(this.rootDirectory, { recursive: true });
    this.jobs = new Map();
    this.deletedOwners = new Set();
    this.load();
  }

  ownerKey(ownerType, ownerId) {
    return `${ownerType}:${ownerId}`;
  }

  load() {
    for (const item of readdirSync(this.rootDirectory, { withFileTypes: true })) {
      if (!item.isFile() || !/^[0-9a-f]{64}\.json$/i.test(item.name)) continue;
      try {
        const job = normalizeJob(JSON.parse(readFileSync(path.join(this.rootDirectory, item.name), "utf8")));
        if (job) this.jobs.set(job.key, job);
      } catch {
        // Damaged job metadata is ignored; its owning project remains recoverable from media files.
      }
    }
  }

  filePath(key) {
    return path.join(this.rootDirectory, `${jobId(key)}.json`);
  }

  save(job) {
    const normalized = normalizeJob(job);
    if (!normalized) throw new Error("invalid_job");
    const target = this.filePath(normalized.key);
    if (this.deletedOwners.has(this.ownerKey(normalized.ownerType, normalized.ownerId))) {
      if (existsSync(target)) rmSync(target, { force: true });
      this.jobs.delete(normalized.key);
      return normalized;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
    this.jobs.set(normalized.key, normalized);
    return normalized;
  }

  getOrCreate({ key, ownerType, ownerId, stage }, now = Date.now()) {
    if (this.deletedOwners.has(this.ownerKey(ownerType, ownerId))) throw new Error("job_owner_deleted");
    const existing = this.jobs.get(key);
    if (existing) return existing;
    return this.save({
      id: jobId(key),
      key,
      ownerType,
      ownerId,
      stage,
      state: "PENDING",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      nextAttemptAt: null,
      lastFailedAt: null,
      error: null,
    });
  }

  start(input, now = Date.now()) {
    const job = this.getOrCreate(input, now);
    job.state = "RUNNING";
    job.attempts += 1;
    job.startedAt = now;
    job.completedAt = null;
    job.nextAttemptAt = null;
    job.updatedAt = now;
    job.error = null;
    return this.save(job);
  }

  succeed(input, now = Date.now()) {
    const job = this.getOrCreate(input, now);
    job.state = "SUCCEEDED";
    job.completedAt = now;
    job.nextAttemptAt = null;
    job.updatedAt = now;
    job.error = null;
    return this.save(job);
  }

  fail(input, error, now = Date.now()) {
    const job = this.getOrCreate(input, now);
    job.state = "FAILED";
    job.completedAt = now;
    job.nextAttemptAt = null;
    job.lastFailedAt = now;
    job.updatedAt = now;
    job.error = String(error || "job_failed").slice(0, 4_000);
    return this.save(job);
  }

  scheduleRetry(input, error, nextAttemptAt, now = Date.now()) {
    const job = this.getOrCreate(input, now);
    job.state = "RETRY_WAIT";
    job.completedAt = null;
    job.nextAttemptAt = Math.max(now, Number(nextAttemptAt) || now);
    job.lastFailedAt = now;
    job.updatedAt = now;
    job.error = String(error || "job_failed").slice(0, 4_000);
    return this.save(job);
  }

  deadLetter(input, error, now = Date.now()) {
    const job = this.getOrCreate(input, now);
    job.state = "DEAD_LETTER";
    job.completedAt = now;
    job.nextAttemptAt = null;
    job.lastFailedAt = now;
    job.updatedAt = now;
    job.error = String(error || "job_failed").slice(0, 4_000);
    return this.save(job);
  }

  getById(id) {
    return this.list().find((job) => job.id === id) ?? null;
  }

  listDeadLetters() {
    return this.list()
      .filter((job) => job.state === "DEAD_LETTER")
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  resetOwnerFailures(ownerType, ownerId, now = Date.now()) {
    const reset = [];
    for (const job of this.jobs.values()) {
      if (job.ownerType !== ownerType || job.ownerId !== ownerId || !["FAILED", "DEAD_LETTER", "RETRY_WAIT"].includes(job.state)) continue;
      job.state = "PENDING";
      job.attempts = 0;
      job.startedAt = null;
      job.completedAt = null;
      job.nextAttemptAt = null;
      job.updatedAt = now;
      job.error = null;
      reset.push(this.save(job));
    }
    return reset;
  }

  list() {
    return [...this.jobs.values()];
  }

  stats(now = Date.now()) {
    const counts = { pending: 0, running: 0, retryWaiting: 0, succeeded: 0, failed: 0, deadLetter: 0 };
    let oldestPendingAt = null;
    let oldestRunningAt = null;
    let lastFailureAt = null;
    for (const job of this.jobs.values()) {
      if (job.state === "RETRY_WAIT") counts.retryWaiting += 1;
      else if (job.state === "DEAD_LETTER") counts.deadLetter += 1;
      else counts[job.state.toLowerCase()] += 1;
      if (["PENDING", "RETRY_WAIT"].includes(job.state)) oldestPendingAt = Math.min(oldestPendingAt ?? job.updatedAt, job.updatedAt);
      if (job.state === "RUNNING") oldestRunningAt = Math.min(oldestRunningAt ?? job.startedAt ?? job.updatedAt, job.startedAt ?? job.updatedAt);
      if (job.lastFailedAt) lastFailureAt = Math.max(lastFailureAt ?? job.lastFailedAt, job.lastFailedAt);
    }
    return {
      total: this.jobs.size,
      ...counts,
      oldestPendingAgeSeconds: oldestPendingAt ? Math.max(0, Math.floor((now - oldestPendingAt) / 1000)) : 0,
      oldestRunningAgeSeconds: oldestRunningAt ? Math.max(0, Math.floor((now - oldestRunningAt) / 1000)) : 0,
      lastFailureAt,
    };
  }

  removeOwner(ownerType, ownerId) {
    this.deletedOwners.add(this.ownerKey(ownerType, ownerId));
    for (const job of this.jobs.values()) {
      if (job.ownerType !== ownerType || job.ownerId !== ownerId) continue;
      this.jobs.delete(job.key);
      const target = this.filePath(job.key);
      if (existsSync(target)) rmSync(target, { force: true });
    }
  }
}
