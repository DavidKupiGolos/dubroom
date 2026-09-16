import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function validProjectId(id) {
  return /^[0-9a-f-]{36}$/i.test(String(id || ""));
}

export class LocalProjectRepository {
  constructor(rootDirectory) {
    this.rootDirectory = path.resolve(rootDirectory);
    mkdirSync(this.rootDirectory, { recursive: true });
    this.projects = new Map();
    this.deletedIds = new Set();
    this.load();
  }

  load() {
    for (const entry of readdirSync(this.rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
      const manifestPath = this.manifestPath(entry.name);
      if (!existsSync(manifestPath)) continue;
      try {
        const project = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (project.id === entry.name) this.projects.set(project.id, project);
      } catch {
        // A partially written project is ignored and can be removed manually.
      }
    }
  }

  directory(id) {
    if (!validProjectId(id)) throw new Error("invalid_project_id");
    return path.join(this.rootDirectory, id);
  }

  manifestPath(id) {
    return path.join(this.directory(id), "project.json");
  }

  insert(project) {
    this.deletedIds.delete(project.id);
    mkdirSync(this.directory(project.id), { recursive: true });
    this.projects.set(project.id, project);
    return this.save(project);
  }

  save(project) {
    if (this.deletedIds.has(project.id)) {
      rmSync(this.directory(project.id), { recursive: true, force: true });
      return project;
    }
    const directory = this.directory(project.id);
    mkdirSync(directory, { recursive: true });
    const target = this.manifestPath(project.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
    this.projects.set(project.id, project);
    return project;
  }

  get(id) {
    return this.projects.get(id) ?? null;
  }

  list() {
    return [...this.projects.values()];
  }

  delete(id) {
    const existed = this.projects.delete(id);
    if (validProjectId(id)) {
      this.deletedIds.add(id);
      rmSync(this.directory(id), { recursive: true, force: true });
    }
    return existed;
  }
}
