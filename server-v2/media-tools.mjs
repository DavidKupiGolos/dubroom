import path from "node:path";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProcess } from "./process-runner.mjs";
import { parsePublicYouTubeUrl } from "./youtube.mjs";

function resolveConfiguredCommand(value) {
  if (!value || path.isAbsolute(value) || !/[\\/]/.test(value)) return value;
  return path.resolve(value);
}

function resolveConfiguredFile(value) {
  return value ? path.resolve(value) : "";
}

export class YouTubeSource {
  constructor({
    executable = process.env.DUBROOM_YTDLP || "yt-dlp",
    runner = runProcess,
    nodeRuntime = process.env.DUBROOM_NODE_RUNTIME || process.execPath,
    cookiesFile = process.env.DUBROOM_YOUTUBE_COOKIES_FILE || "",
    cookiesFromBrowser = process.env.DUBROOM_YOUTUBE_COOKIES_FROM_BROWSER || "",
  } = {}) {
    this.executable = resolveConfiguredCommand(executable);
    this.runner = runner;
    this.nodeRuntime = resolveConfiguredCommand(nodeRuntime);
    this.cookiesFile = resolveConfiguredFile(cookiesFile);
    this.cookiesFromBrowser = cookiesFromBrowser;
  }

  commonArgs(cookiesFile = this.cookiesFile) {
    const args = [
      "--encoding", "utf-8",
      "--no-color",
      "--js-runtimes", `node:${this.nodeRuntime}`,
      "--remote-components", "ejs:github",
    ];
    if (cookiesFile) args.push("--cookies", cookiesFile);
    else if (this.cookiesFromBrowser) args.push("--cookies-from-browser", this.cookiesFromBrowser);
    return args;
  }

  async run(args, options) {
    let temporaryDirectory = "";
    let cookiesFile = this.cookiesFile;
    if (cookiesFile) {
      temporaryDirectory = mkdtempSync(path.join(tmpdir(), "dubroom-ytdlp-"));
      const temporaryCookies = path.join(temporaryDirectory, "cookies.txt");
      copyFileSync(cookiesFile, temporaryCookies);
      cookiesFile = temporaryCookies;
    }
    try {
      return await this.runner(this.executable, [...this.commonArgs(cookiesFile), ...args], options);
    } finally {
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async inspect(sourceUrl) {
    const source = parsePublicYouTubeUrl(sourceUrl);
    const result = await this.run([
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      source.canonicalUrl,
    ]);
    const metadata = JSON.parse(result.stdout);
    if (metadata.id !== source.videoId || metadata.availability !== "public") {
      throw new Error("youtube_video_not_public");
    }
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.duration > 6 * 60 * 60) {
      throw new Error("youtube_duration_not_supported");
    }
    return {
      videoId: source.videoId,
      canonicalUrl: source.canonicalUrl,
      title: String(metadata.title || "Видео").slice(0, 200),
      duration: metadata.duration,
    };
  }

  async download(sourceUrl, targetDirectory, projectId, maximumBytes = 2 * 1024 * 1024 * 1024) {
    const source = parsePublicYouTubeUrl(sourceUrl);
    const outputTemplate = path.join(targetDirectory, `${projectId}.%(ext)s`);
    const result = await this.run([
      "--no-playlist",
      "--max-filesize", String(Math.max(1, Math.floor(maximumBytes))),
      "--merge-output-format", "mp4",
      "--format", "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<=1080]",
      "--print", "after_move:filepath",
      "--output", outputTemplate,
      source.canonicalUrl,
    ], { cwd: targetDirectory });
    const outputPath = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!outputPath) throw new Error("youtube_download_output_missing");
    return path.isAbsolute(outputPath) ? outputPath : path.resolve(targetDirectory, outputPath);
  }
}

export class MediaTools {
  constructor({
    ffmpeg = process.env.DUBROOM_FFMPEG || "ffmpeg",
    ffprobe = process.env.DUBROOM_FFPROBE || "ffprobe",
    runner = runProcess,
  } = {}) {
    this.ffmpeg = resolveConfiguredCommand(ffmpeg);
    this.ffprobe = resolveConfiguredCommand(ffprobe);
    this.runner = runner;
  }

  async inspect(inputPath) {
    const result = await this.runner(this.ffprobe, [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      inputPath,
    ]);
    const media = JSON.parse(result.stdout);
    const video = media.streams?.find((stream) => stream.codec_type === "video");
    const audio = media.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(media.format?.duration);
    if (!video || !audio || !Number.isFinite(duration) || duration <= 0) throw new Error("invalid_source_media");
    return {
      duration,
      videoCodec: video.codec_name,
      width: Number(video.width),
      height: Number(video.height),
      audioCodec: audio.codec_name,
      canCopyVideoToMp4: ["h264", "hevc", "av1"].includes(video.codec_name),
    };
  }

  async extractAudio(inputPath, outputPath) {
    await this.runner(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:a:0",
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-c:a", "pcm_s16le",
      outputPath,
    ]);
    return outputPath;
  }

  async createStubVideo(outputPath, duration = 4) {
    await this.runner(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0x171a18:s=1280x720:r=30:d=${duration}`,
      "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=44100:duration=${duration}`,
      "-vf", "drawtext=text='DUBROOM LOCAL TEST':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
      outputPath,
    ]);
    return outputPath;
  }

  async normalizeVideo(inputPath, outputPath) {
    await this.runner(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath,
    ], { timeoutMs: 2 * 60 * 60 * 1000 });
    return outputPath;
  }

  async createVideoPoster(inputPath, outputPath) {
    await this.runner(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", "0.25",
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale='min(960,iw)':-2",
      "-q:v", "3",
      outputPath,
    ]);
    return outputPath;
  }

  async normalizePoster(inputPath, outputPath) {
    await this.runner(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-frames:v", "1",
      "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1",
      "-q:v", "3",
      outputPath,
    ]);
    return outputPath;
  }

  async assembleDub({ videoPath, instrumentalPath, cues, takePaths, duration, outputPath }) {
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-i", instrumentalPath];
    for (const cue of cues) args.push("-i", takePaths.get(cue.id));

    const filters = [
      `[1:a]aresample=48000,asetpts=PTS-STARTPTS,apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}[background]`,
    ];
    const tracks = ["[background]"];
    cues.forEach((cue, index) => {
      const cueDuration = Math.max(0.1, cue.end - cue.start);
      const delay = Math.max(0, Math.round(cue.start * 1000));
      const label = `take${index}`;
      filters.push(`[${index + 2}:a]aresample=48000,asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,atrim=duration=${cueDuration.toFixed(3)},apad=whole_dur=${cueDuration.toFixed(3)},adelay=${delay}:all=1[${label}]`);
      tracks.push(`[${label}]`);
    });
    filters.push(`${tracks.join("")}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,atrim=duration=${duration.toFixed(3)}[mixed]`);

    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "0:v:0",
      "-map", "[mixed]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-t", duration.toFixed(3),
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      outputPath,
    );
    await this.runner(this.ffmpeg, args, { timeoutMs: 2 * 60 * 60 * 1000 });
    return outputPath;
  }
}
