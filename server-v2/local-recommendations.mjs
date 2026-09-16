import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

function validId(id) {
  return /^[0-9a-f-]{36}$/i.test(String(id || ""));
}

function normalizeEntry(entry) {
  entry.media = entry.media && typeof entry.media === "object" ? entry.media : {};
  entry.cues = Array.isArray(entry.cues) ? entry.cues : [];
  entry.stemsStatus = entry.stemsStatus || "pending";
  entry.transcriptStatus = entry.transcriptStatus || "pending";
  entry.preparedAt = Number.isFinite(entry.preparedAt) ? entry.preparedAt : null;
  entry.categoryId = validId(entry.categoryId) ? entry.categoryId : null;
  return entry;
}

function cleanCategoryName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 48) throw new Error("invalid_recommendation_category_name");
  return name;
}

export class LocalRecommendationStore {
  constructor(dataRoot) {
    this.rootDirectory = path.join(path.resolve(dataRoot), "recommendations");
    mkdirSync(this.rootDirectory, { recursive: true });
    this.entries = new Map();
    this.categories = new Map();
    this.deletedIds = new Set();
    this.loadCategories();
    this.load();
  }

  categoriesPath() {
    return path.join(this.rootDirectory, "categories.json");
  }

  loadCategories() {
    try {
      const categories = JSON.parse(readFileSync(this.categoriesPath(), "utf8"));
      for (const category of Array.isArray(categories) ? categories : []) {
        if (validId(category.id) && typeof category.name === "string") this.categories.set(category.id, category);
      }
    } catch {
      // A new catalog starts without categories.
    }
  }

  load() {
    for (const item of readdirSync(this.rootDirectory, { withFileTypes: true })) {
      if (!item.isDirectory() || !validId(item.name)) continue;
      try {
        const entry = JSON.parse(readFileSync(this.manifestPath(item.name), "utf8"));
        if (entry.id === item.name) {
          normalizeEntry(entry);
          if (entry.categoryId && !this.categories.has(entry.categoryId)) entry.categoryId = null;
          this.entries.set(entry.id, entry);
        }
      } catch {
        // An incomplete upload remains isolated until an administrator removes it.
      }
    }
  }

  directory(id) {
    if (!validId(id)) throw new Error("invalid_recommendation_id");
    return path.join(this.rootDirectory, id);
  }

  manifestPath(id) {
    return path.join(this.directory(id), "recommendation.json");
  }

  create({ title, originalName, bytes = null, sourceType = "upload", sourceUrl = null, sourceVideoId = null, useSourceTitle = false, categoryId = null }, now = Date.now()) {
    if (categoryId && !this.categories.has(categoryId)) throw new Error("recommendation_category_not_found");
    const id = randomUUID();
    const entry = {
      id,
      title,
      originalName,
      sourceType,
      sourceUrl,
      sourceVideoId,
      useSourceTitle,
      state: "PROCESSING",
      progress: 5,
      duration: 0,
      width: 0,
      height: 0,
      bytes: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
      errorDetail: null,
      sourceFile: "source.mp4",
      videoFile: null,
      posterFile: null,
      media: {},
      cues: [],
      stemsStatus: "pending",
      transcriptStatus: "pending",
      preparedAt: null,
      categoryId: categoryId || null,
    };
    const directory = this.directory(id);
    mkdirSync(directory, { recursive: true });
    if (bytes) writeFileSync(path.join(directory, entry.sourceFile), bytes);
    this.entries.set(id, entry);
    return this.save(entry);
  }

  sourcePath(id) {
    return path.join(this.directory(id), "source.mp4");
  }

  save(entry) {
    if (this.deletedIds.has(entry.id)) return entry;
    normalizeEntry(entry);
    const directory = this.directory(entry.id);
    mkdirSync(directory, { recursive: true });
    const target = this.manifestPath(entry.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id) {
    return this.entries.get(id) ?? null;
  }

  list() {
    return [...this.entries.values()];
  }

  listCategories() {
    return [...this.categories.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  saveCategories() {
    const target = this.categoriesPath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.listCategories(), null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  assertUniqueCategoryName(name, excludedId = null) {
    const normalized = name.toLocaleLowerCase("ru-RU");
    if (this.listCategories().some((category) => category.id !== excludedId && category.name.toLocaleLowerCase("ru-RU") === normalized)) {
      throw new Error("recommendation_category_name_conflict");
    }
  }

  createCategory(name, now = Date.now()) {
    const cleanName = cleanCategoryName(name);
    this.assertUniqueCategoryName(cleanName);
    const category = { id: randomUUID(), name: cleanName, createdAt: now, updatedAt: now };
    this.categories.set(category.id, category);
    this.saveCategories();
    return category;
  }

  updateCategory(id, name, now = Date.now()) {
    const category = this.categories.get(id);
    if (!category) throw new Error("recommendation_category_not_found");
    const cleanName = cleanCategoryName(name);
    this.assertUniqueCategoryName(cleanName, id);
    category.name = cleanName;
    category.updatedAt = now;
    this.saveCategories();
    return category;
  }

  removeCategory(id) {
    if (!this.categories.delete(id)) throw new Error("recommendation_category_not_found");
    for (const entry of this.entries.values()) {
      if (entry.categoryId !== id) continue;
      entry.categoryId = null;
      this.save(entry);
    }
    this.saveCategories();
  }

  setCategory(id, categoryId = null) {
    const entry = this.get(id);
    if (!entry) throw new Error("recommendation_not_found");
    if (categoryId && !this.categories.has(categoryId)) throw new Error("recommendation_category_not_found");
    entry.categoryId = categoryId || null;
    entry.updatedAt = Date.now();
    return this.save(entry);
  }

  remove(id) {
    const existed = this.entries.delete(id);
    if (validId(id)) {
      this.deletedIds.add(id);
      rmSync(this.directory(id), { recursive: true, force: true });
    }
    return existed;
  }

  asset(id, kind) {
    const entry = this.get(id);
    if (!entry || entry.state !== "READY") throw new Error("recommendation_not_found");
    const fileName = kind === "poster" ? entry.posterFile : entry.videoFile;
    if (!fileName) throw new Error("recommendation_asset_not_found");
    const filePath = path.join(this.directory(id), path.basename(fileName));
    if (!existsSync(filePath)) throw new Error("recommendation_asset_not_found");
    return {
      filePath,
      stat: statSync(filePath),
      contentType: kind === "poster" ? "image/jpeg" : "video/mp4",
    };
  }
}
