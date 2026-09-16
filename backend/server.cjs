const http = require("node:http");
const { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const path = require("node:path");

const host = "127.0.0.1";
const port = Number(process.env.DUBROOM_PORT || 5179);
const jobs = new Map();
const allowedSite = "https://dubroom-studio.tbatrazzz.chatgpt.site";
const maximumVideoBytes = 2 * 1024 * 1024 * 1024;
const maximumAudioBytes = 250 * 1024 * 1024;
const jobsRoot = path.join(tmpdir(), "dubroom-render-jobs");
mkdirSync(jobsRoot, { recursive: true });

function allowedOrigin(origin) {
  return !origin
    || origin === allowedSite
    || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function headers(request, contentType = "application/json; charset=utf-8") {
  const origin = request.headers.origin;
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigin(origin) ? origin : allowedSite,
    "Access-Control-Allow-Headers": "Content-Type, X-File-Name",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Vary": "Origin",
    "Content-Type": contentType,
  };
}

function sendJson(request, response, status, body) {
  response.writeHead(status, headers(request));
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function saveRequestBody(request, target, limit) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > limit) callback(new Error("request_too_large"));
      else callback(null, chunk);
    },
  });
  await pipeline(request, limiter, createWriteStream(target));
  return size;
}

function safeVideoExtension(fileName) {
  const extension = path.extname(String(fileName || "")).toLowerCase();
  return [".mp4", ".mov", ".webm", ".ogv", ".ogg", ".mkv"].includes(extension) ? extension : ".video";
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error("job_not_found");
  return job;
}

function ffmpegFromSea() {
  try {
    const sea = require("node:sea");
    if (!sea.isSea()) return null;
    const targetDir = path.join(tmpdir(), "dubroom-backend-tools");
    const target = path.join(targetDir, "ffmpeg.exe");
    if (!existsSync(target)) {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, Buffer.from(sea.getRawAsset("ffmpeg.exe")));
    }
    return target;
  } catch {
    return null;
  }
}

function resolveFfmpeg() {
  if (process.env.DUBROOM_FFMPEG) return process.env.DUBROOM_FFMPEG;
  const seaAsset = ffmpegFromSea();
  if (seaAsset) return seaAsset;
  const local = path.join(__dirname, "tools", "ffmpeg.exe");
  if (existsSync(local)) return local;
  return "ffmpeg";
}

const ffmpegPath = resolveFfmpeg();

function buildAudioFilter(job) {
  const filters = [];
  const tracks = [];
  let inputIndex = 1;
  if (job.backingPath) {
    filters.push(`[${inputIndex}:a]aresample=48000,asetpts=PTS-STARTPTS,atrim=duration=${job.duration.toFixed(3)}[background]`);
    tracks.push("[background]");
    inputIndex += 1;
  }
  for (const cue of job.cues) {
    const label = `take${tracks.length}`;
    const cueDuration = Math.max(0.1, cue.end - cue.start);
    const delay = Math.max(0, Math.round(cue.start * 1000));
    filters.push(`[${inputIndex}:a]aresample=48000,asetpts=PTS-STARTPTS,atrim=duration=${cueDuration.toFixed(3)},adelay=${delay}:all=1[${label}]`);
    tracks.push(`[${label}]`);
    inputIndex += 1;
  }
  filters.push(`${tracks.join("")}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad=whole_dur=${job.duration.toFixed(3)},atrim=duration=${job.duration.toFixed(3)}[mixed]`);
  return filters.join(";");
}

function runFfmpeg(job, copyVideo) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", job.videoPath];
    if (job.backingPath) args.push("-i", job.backingPath);
    for (const cue of job.cues) args.push("-i", job.takePaths.get(cue.id));
    args.push(
      "-filter_complex", buildAudioFilter(job),
      "-map", "0:v:0", "-map", "[mixed]",
      "-c:v", copyVideo ? "copy" : "libx264",
    );
    if (!copyVideo) args.push("-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    args.push(
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", job.duration.toFixed(3), "-movflags", "+faststart",
      "-map_metadata", "-1", "-progress", "pipe:1", "-nostats", job.outputPath,
    );

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    let progressBuffer = "";
    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = /^(?:out_time_us|out_time_ms)=(\d+)$/.exec(line);
        if (!match) continue;
        const elapsed = Number(match[1]) / 1_000_000;
        job.progress = Math.min(98, Math.max(job.progress, Math.round((elapsed / job.duration) * 100)));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `ffmpeg_exit_${code}`)));
  });
}

async function renderJob(job) {
  job.status = "rendering";
  job.progress = 1;
  job.error = null;
  try {
    try {
      await runFfmpeg(job, true);
    } catch {
      if (existsSync(job.outputPath)) rmSync(job.outputPath, { force: true });
      job.progress = 1;
      await runFfmpeg(job, false);
    }
    job.status = "ready";
    job.progress = 100;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "ffmpeg_failed";
  }
}

function sendOutput(request, response, job) {
  const stat = statSync(job.outputPath);
  const range = request.headers.range;
  const baseHeaders = headers(request, "video/mp4");
  baseHeaders["Accept-Ranges"] = "bytes";
  baseHeaders["Content-Disposition"] = `inline; filename="${job.outputName}"`;
  if (!range) {
    response.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
    createReadStream(job.outputPath).pipe(response);
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) {
    response.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...baseHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
  });
  createReadStream(job.outputPath, { start, end }).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (!allowedOrigin(origin)) {
    sendJson(request, response, 403, { error: "origin_not_allowed" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers(request));
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${host}:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(request, response, 200, { status: "ready", service: "dubroom-backend", version: "2.0", score: true, render: true, format: "mp4" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/score") {
      let receivedBytes = 0;
      for await (const chunk of request) {
        receivedBytes += chunk.length;
        if (receivedBytes > maximumAudioBytes) throw new Error("request_too_large");
      }
      sendJson(request, response, 200, { score: 100, metrics: { timing: 100, clarity: 100, emotion: 100 }, received_bytes: receivedBytes, engine: "stub" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/render/jobs") {
      const input = await readJson(request);
      const duration = Number(input.duration);
      const cues = Array.isArray(input.cues) ? input.cues.map((cue) => ({ id: String(cue.id), start: Number(cue.start), end: Number(cue.end) })) : [];
      if (!Number.isFinite(duration) || duration <= 0 || duration > 6 * 60 * 60 || !cues.length || cues.length > 500) throw new Error("invalid_manifest");
      if (cues.some((cue) => !/^[a-zA-Z0-9_-]{1,40}$/.test(cue.id) || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > duration + 1)) throw new Error("invalid_manifest");
      const id = randomUUID();
      const directory = path.join(jobsRoot, id);
      mkdirSync(directory, { recursive: true });
      const extension = safeVideoExtension(input.videoName);
      const baseName = path.basename(String(input.videoName || "dubroom"), path.extname(String(input.videoName || ""))).replace(/[^a-zA-Z0-9_-]+/g, "-") || "dubroom";
      const job = {
        id, directory, duration, cues, createdAt: Date.now(), status: "uploading", progress: 0, error: null,
        videoPath: path.join(directory, `source${extension}`), backingPath: null, takePaths: new Map(),
        outputPath: path.join(directory, "result.mp4"), outputName: `${baseName}-dub.mp4`,
      };
      jobs.set(id, job);
      sendJson(request, response, 201, { jobId: id, status: job.status });
      return;
    }

    if (parts[0] === "api" && parts[1] === "render" && parts[2] === "jobs" && parts[3]) {
      const job = getJob(parts[3]);
      if (request.method === "PUT" && parts[4] === "video") {
        await saveRequestBody(request, job.videoPath, maximumVideoBytes);
        sendJson(request, response, 200, { uploaded: "video" });
        return;
      }
      if (request.method === "PUT" && parts[4] === "backing") {
        job.backingPath = path.join(job.directory, "backing-audio");
        await saveRequestBody(request, job.backingPath, maximumAudioBytes);
        sendJson(request, response, 200, { uploaded: "backing" });
        return;
      }
      if (request.method === "PUT" && parts[4] === "takes" && parts[5]) {
        const cueId = decodeURIComponent(parts[5]);
        if (!job.cues.some((cue) => cue.id === cueId)) throw new Error("cue_not_found");
        const target = path.join(job.directory, `take-${cueId}.webm`);
        await saveRequestBody(request, target, maximumAudioBytes);
        job.takePaths.set(cueId, target);
        sendJson(request, response, 200, { uploaded: cueId });
        return;
      }
      if (request.method === "POST" && parts[4] === "complete") {
        if (!existsSync(job.videoPath) || job.cues.some((cue) => !job.takePaths.has(cue.id))) throw new Error("missing_inputs");
        if (job.status !== "rendering" && job.status !== "ready") void renderJob(job);
        sendJson(request, response, 202, { jobId: job.id, status: job.status });
        return;
      }
      if (request.method === "GET" && parts[4] === "status") {
        sendJson(request, response, 200, { jobId: job.id, status: job.status, progress: job.progress, error: job.error, outputName: job.status === "ready" ? job.outputName : null });
        return;
      }
      if (request.method === "GET" && parts[4] === "output") {
        if (job.status !== "ready" || !existsSync(job.outputPath)) throw new Error("output_not_ready");
        sendOutput(request, response, job);
        return;
      }
      if (request.method === "DELETE" && parts.length === 4) {
        jobs.delete(job.id);
        rmSync(job.directory, { recursive: true, force: true });
        sendJson(request, response, 200, { deleted: true });
        return;
      }
    }

    sendJson(request, response, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "backend_error";
    const status = message === "job_not_found" ? 404 : message === "request_too_large" ? 413 : 400;
    sendJson(request, response, status, { error: message });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt >= cutoff || job.status === "rendering") continue;
    jobs.delete(id);
    rmSync(job.directory, { recursive: true, force: true });
  }
}, 30 * 60 * 1000).unref();

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Close the previous DUBROOM backend first.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`DUBROOM backend is ready at http://${host}:${port}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log("Scoring returns 100/100; rendering produces MP4. Press Ctrl+C to stop.");
});
