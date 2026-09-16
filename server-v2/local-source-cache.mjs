import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const cachedMediaKeys = ["source", "prepared", "transcript", "instrumental", "vocals"];

function validVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(String(value || ""));
}

function safeName(value) {
  const name = path.basename(String(value || ""));
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(name)) throw new Error("invalid_cache_asset_name");
  return name;
}

function cloneFile(source, target) {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function directoryBytes(directory) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += statSync(target).size;
  }
  return total;
}

export class LocalSourceCache {
  constructor(rootDirectory) {
    this.rootDirectory = path.join(path.resolve(rootDirectory), "cache");
    mkdirSync(this.rootDirectory, { recursive: true });
  }

  directory(videoId) {
    if (!validVideoId(videoId)) throw new Error("invalid_youtube_video_id");
    return path.join(this.rootDirectory, videoId);
  }

  metadataPath(videoId) {
    return path.join(this.directory(videoId), "cache.json");
  }

  read(videoId) {
    const target = this.metadataPath(videoId);
    if (!existsSync(target)) return null;
    try {
      const entry = JSON.parse(readFileSync(target, "utf8"));
      if (entry.videoId !== videoId) return null;
      return entry;
    } catch {
      return null;
    }
  }

  write(entry) {
    const target = this.metadataPath(entry.videoId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  get(videoId, retentionMs, now = Date.now()) {
    const entry = this.read(videoId);
    if (!entry || now >= Number(entry.lastUsedAt || entry.createdAt) + retentionMs) return null;
    const directory = this.directory(videoId);
    if (!entry.media?.prepared || !entry.media?.instrumental) return null;
    if (!existsSync(path.join(directory, safeName(entry.media.prepared)))
      || !existsSync(path.join(directory, safeName(entry.media.instrumental)))) return null;
    entry.lastUsedAt = now;
    this.write(entry);
    return { ...entry, directory };
  }

  put(videoId, sourceDirectory, project, now = Date.now()) {
    const directory = this.directory(videoId);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const media = {};
    for (const key of cachedMediaKeys) {
      const fileName = project.media?.[key];
      if (!fileName) continue;
      const name = safeName(fileName);
      const source = path.join(sourceDirectory, name);
      if (!existsSync(source)) continue;
      cloneFile(source, path.join(directory, name));
      media[key] = name;
    }
    if (!media.prepared || !media.instrumental) throw new Error("cache_assets_missing");
    const entry = {
      videoId,
      sourceUrl: project.sourceUrl,
      title: project.title,
      duration: project.duration,
      cues: project.cues.map((cue) => ({ ...cue })),
      media,
      createdAt: now,
      lastUsedAt: now,
    };
    this.write(entry);
    return { ...entry, directory };
  }

  list() {
    const entries = [];
    for (const item of readdirSync(this.rootDirectory, { withFileTypes: true })) {
      if (!item.isDirectory() || !validVideoId(item.name)) continue;
      const entry = this.read(item.name);
      if (entry) entries.push({ ...entry, bytes: directoryBytes(this.directory(item.name)) });
    }
    return entries;
  }

  remove(videoId) {
    rmSync(this.directory(videoId), { recursive: true, force: true });
  }

  clear() {
    for (const entry of this.list()) this.remove(entry.videoId);
  }

  cleanup(retentionMs, maximumBytes, now = Date.now()) {
    const entries = this.list().sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of entries) {
      if (now >= Number(entry.lastUsedAt || entry.createdAt) + retentionMs) this.remove(entry.videoId);
    }
    const remaining = this.list().sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    let total = remaining.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of remaining) {
      if (total <= maximumBytes) break;
      this.remove(entry.videoId);
      total -= entry.bytes;
    }
  }
}
