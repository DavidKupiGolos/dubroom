import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const defaultServerSettings = Object.freeze({
  projectRetentionMinutes: 60,
  cacheRetentionHours: 72,
  maxVideoDurationMinutes: 10,
  maxSourceFileMb: 2048,
  maxTakeFileMb: 100,
  maxProjects: 100,
  maxTotalStorageGb: 50,
  maxCacheStorageGb: 30,
  minFreeStorageGb: 1,
  pipelineConcurrency: 1,
  maxAutomaticJobAttempts: 3,
  retryBaseDelaySeconds: 2,
  maxProjectCreationsPerMinute: 6,
});

const limits = Object.freeze({
  projectRetentionMinutes: [15, 1440],
  cacheRetentionHours: [1, 720],
  maxVideoDurationMinutes: [1, 360],
  maxSourceFileMb: [50, 4096],
  maxTakeFileMb: [1, 500],
  maxProjects: [1, 10_000],
  maxTotalStorageGb: [1, 2000],
  maxCacheStorageGb: [1, 2000],
  minFreeStorageGb: [0.1, 500],
  pipelineConcurrency: [1, 8],
  maxAutomaticJobAttempts: [1, 5],
  retryBaseDelaySeconds: [1, 300],
  maxProjectCreationsPerMinute: [1, 120],
});

function normalize(input, current = defaultServerSettings) {
  const settings = {};
  for (const [key, [minimum, maximum]] of Object.entries(limits)) {
    const value = Number(input?.[key] ?? current[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`invalid_setting:${key}`);
    }
    settings[key] = Math.round(value * 100) / 100;
  }
  if (settings.maxCacheStorageGb > settings.maxTotalStorageGb) {
    throw new Error("invalid_setting:maxCacheStorageGb");
  }
  return settings;
}

export class LocalSettingsStore {
  constructor(rootDirectory) {
    this.filePath = path.join(path.resolve(rootDirectory), "settings.json");
    this.settings = { ...defaultServerSettings };
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    try {
      this.settings = normalize(JSON.parse(readFileSync(this.filePath, "utf8")), defaultServerSettings);
    } catch {
      this.settings = { ...defaultServerSettings };
    }
  }

  get() {
    return { ...this.settings };
  }

  update(input) {
    this.settings = normalize(input, this.settings);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    renameSync(temporary, this.filePath);
    return this.get();
  }
}

export function settingLimits() {
  return Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, { minimum: value[0], maximum: value[1] }]));
}
