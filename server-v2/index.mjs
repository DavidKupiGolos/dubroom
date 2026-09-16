import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpServer } from "./http-server.mjs";
import { LocalProjectRepository } from "./local-repository.mjs";
import { LocalProjectService } from "./local-project-service.mjs";

const host = process.env.DUBROOM_V2_HOST || "127.0.0.1";
const port = Number(process.env.DUBROOM_V2_PORT || 5180);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("Startup configuration check failed: invalid DUBROOM_V2_PORT");
  process.exit(1);
}
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(currentDirectory, "..");
const bundledTools = path.join(workspaceDirectory, "backend", "tools");
if (!process.env.DUBROOM_FFMPEG && existsSync(path.join(bundledTools, "ffmpeg.exe"))) process.env.DUBROOM_FFMPEG = path.join(bundledTools, "ffmpeg.exe");
if (!process.env.DUBROOM_FFPROBE && existsSync(path.join(bundledTools, "ffprobe.exe"))) process.env.DUBROOM_FFPROBE = path.join(bundledTools, "ffprobe.exe");
if (!process.env.DUBROOM_YTDLP && existsSync(path.join(bundledTools, "yt-dlp.exe"))) process.env.DUBROOM_YTDLP = path.join(bundledTools, "yt-dlp.exe");
const dataRoot = process.env.DUBROOM_DATA_ROOT || path.resolve(currentDirectory, "..", "work", "server-v2-data");
const repository = new LocalProjectRepository(dataRoot);
const service = new LocalProjectService({ repository, autoStart: false });
try {
  if (service.pipelineMode === "real" && !String(process.env.DUBROOM_ADMIN_API_TOKEN || "").trim()) {
    throw new Error("runtime_dependency_check_failed:admin_api_token");
  }
  if (service.pipelineMode === "real" && !String(process.env.DUBROOM_ALLOWED_ORIGINS || "").trim()) {
    throw new Error("runtime_dependency_check_failed:allowed_origins");
  }
  service.verifyRuntimeDependencies();
  service.start();
} catch (error) {
  console.error("Startup dependency check failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const server = createHttpServer({ service });

const cleanupTimer = setInterval(() => service.cleanup(), 60 * 1000);
cleanupTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  console.log(`Received ${signal}, stopping HTTP server`);
  const forceExit = setTimeout(() => process.exit(1), 25_000);
  forceExit.unref();
  await new Promise((resolve) => server.close(resolve));
  await service.shutdown();
  clearTimeout(forceExit);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`Dubroom server v3 is ready at http://${host}:${port}`);
  console.log(`Data: ${dataRoot}`);
  console.log(`Pipeline: ${service.pipelineMode}`);
});
