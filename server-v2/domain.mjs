import { randomBytes, randomUUID } from "node:crypto";

export const projectStates = Object.freeze([
  "CREATED",
  "INGESTING",
  "EXTRACTING_AUDIO",
  "ANALYZING",
  "BUILDING_CUES",
  "READY_TO_DUB",
  "RECORDING",
  "FINALIZING",
  "READY",
  "FAILED",
]);

export const workingRetentionMs = 60 * 60 * 1000;

const transitions = new Map([
  ["CREATED", new Set(["INGESTING", "FAILED"])],
  ["INGESTING", new Set(["EXTRACTING_AUDIO", "FAILED"])],
  ["EXTRACTING_AUDIO", new Set(["ANALYZING", "FAILED"])],
  ["ANALYZING", new Set(["BUILDING_CUES", "FAILED"])],
  ["BUILDING_CUES", new Set(["READY_TO_DUB", "FAILED"])],
  ["READY_TO_DUB", new Set(["RECORDING", "FAILED"])],
  ["RECORDING", new Set(["FINALIZING", "FAILED"])],
  ["FINALIZING", new Set(["READY", "FAILED"])],
  ["READY", new Set()],
  ["FAILED", new Set()],
]);

export function transitionProject(project, nextState, now = Date.now()) {
  if (!projectStates.includes(nextState)) throw new Error("invalid_project_state");
  if (!transitions.get(project.state)?.has(nextState)) {
    throw new Error(`invalid_project_transition:${project.state}:${nextState}`);
  }
  project.state = nextState;
  project.updatedAt = now;
  project.events.push({ state: nextState, at: now });
  return project;
}

export function createProject(sourceUrl, now = Date.now(), retentionMs = workingRetentionMs) {
  return {
    id: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    sourceUrl,
    state: "CREATED",
    stemsStatus: "pending",
    transcriptStatus: "pending",
    progress: 0,
    manifestRevision: 1,
    cues: [],
    takes: {},
    title: "Видео",
    duration: 0,
    media: {},
    createdAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    sourceExpiresAt: now + retentionMs,
    workingExpiresAt: now + retentionMs,
    workingFilesExpiredAt: null,
    error: null,
    errorDetail: null,
    reusedFromProjectId: null,
    events: [{ state: "CREATED", at: now }],
  };
}

export function touchProject(project, now = Date.now(), retentionMs = workingRetentionMs) {
  project.lastHeartbeatAt = now;
  project.sourceExpiresAt = now + retentionMs;
  project.workingExpiresAt = now + retentionMs;
  project.updatedAt = now;
  return project;
}

export function recoverProject(project, nextState, now = Date.now()) {
  if (!projectStates.includes(nextState)) throw new Error("invalid_project_state");
  project.state = nextState;
  project.updatedAt = now;
  project.error = null;
  project.errorDetail = null;
  project.events.push({ state: nextState, at: now, reason: "recovered" });
  return project;
}

export function publicProject(project) {
  return {
    id: project.id,
    sourceUrl: project.sourceUrl,
    state: project.state,
    stemsStatus: project.stemsStatus,
    transcriptStatus: project.transcriptStatus,
    progress: project.progress,
    manifestRevision: project.manifestRevision || 1,
    cues: project.cues,
    recordedCueIds: Object.keys(project.takes || {}),
    title: project.title,
    duration: project.duration,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sourceExpiresAt: project.sourceExpiresAt,
    workingExpiresAt: project.workingExpiresAt,
    error: project.error,
    events: project.events,
  };
}
