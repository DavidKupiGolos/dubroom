import { buildCues } from "./cues.mjs";
import { createProject, publicProject, touchProject, transitionProject } from "./domain.mjs";
import { parsePublicYouTubeUrl } from "./youtube.mjs";

const stubWords = [
  { type: "word", text: "Тестовая", start: 0.2, end: 0.55 },
  { type: "word", text: "реплика.", start: 0.58, end: 1.05 },
  { type: "word", text: "Вторая", start: 1.9, end: 2.25 },
  { type: "word", text: "реплика.", start: 2.28, end: 2.8 },
];

export class InMemoryProjectRepository {
  #projects = new Map();

  insert(project) {
    this.#projects.set(project.id, project);
    return project;
  }

  get(id) {
    return this.#projects.get(id) ?? null;
  }

  list() {
    return [...this.#projects.values()];
  }

  delete(id) {
    return this.#projects.delete(id);
  }
}

export class ProjectService {
  constructor({ repository = new InMemoryProjectRepository(), pipeline = "stub" } = {}) {
    this.repository = repository;
    this.pipeline = pipeline;
  }

  create({ sourceUrl, rightsAccepted }) {
    if (rightsAccepted !== true) throw new Error("rights_confirmation_required");
    const source = parsePublicYouTubeUrl(sourceUrl);
    const project = this.repository.insert(createProject(source.canonicalUrl));
    queueMicrotask(() => void this.process(project.id));
    return { project: publicProject(project), token: project.token };
  }

  get(id, token) {
    const project = this.requireAuthorized(id, token);
    return publicProject(project);
  }

  projectEvents(id, token) {
    return this.requireAuthorized(id, token).events.map((event) => ({ ...event }));
  }

  listAdminProjects() {
    return this.repository.list()
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(publicProject);
  }

  removeAdminProject(id) {
    if (!this.repository.get(id)) throw new Error("project_not_found");
    this.repository.delete(id);
  }

  heartbeat(id, token) {
    return publicProject(touchProject(this.requireAuthorized(id, token)));
  }

  resultStatus(id, token) {
    return { project: publicProject(this.requireAuthorized(id, token)), resultUrl: null };
  }

  remove(id, token) {
    this.requireAuthorized(id, token);
    this.repository.delete(id);
  }

  requireAuthorized(id, token) {
    const project = this.repository.get(id);
    if (!project) throw new Error("project_not_found");
    if (!token || token !== project.token) throw new Error("project_unauthorized");
    return project;
  }

  async process(id) {
    const project = this.repository.get(id);
    if (!project || project.state !== "CREATED") return;
    try {
      if (this.pipeline !== "stub") throw new Error("pipeline_not_configured");
      transitionProject(project, "INGESTING");
      project.progress = 15;
      await Promise.resolve();
      transitionProject(project, "EXTRACTING_AUDIO");
      project.progress = 30;
      await Promise.resolve();
      transitionProject(project, "ANALYZING");
      project.progress = 45;
      project.stemsStatus = "running";
      project.transcriptStatus = "running";
      await Promise.resolve();
      project.stemsStatus = "ready";
      project.transcriptStatus = "ready";
      project.progress = 80;
      transitionProject(project, "BUILDING_CUES");
      project.cues = buildCues(stubWords);
      project.progress = 95;
      transitionProject(project, "READY_TO_DUB");
      project.progress = 100;
    } catch (error) {
      project.error = error instanceof Error ? error.message : "pipeline_failed";
      if (project.state !== "FAILED") transitionProject(project, "FAILED");
    }
  }
}
