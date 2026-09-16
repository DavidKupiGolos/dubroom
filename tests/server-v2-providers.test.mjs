import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ElevenLabsClient } from "../server-v2/elevenlabs.mjs";
import { MediaTools, YouTubeSource } from "../server-v2/media-tools.mjs";

test("YouTube adapter verifies public availability before processing", async () => {
  const calls = [];
  const source = new YouTubeSource({ runner: async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: JSON.stringify({ id: "dQw4w9WgXcQ", availability: "public", duration: 240, title: "Own video" }), stderr: "" };
  } });
  const metadata = await source.inspect("https://youtu.be/dQw4w9WgXcQ");
  assert.equal(metadata.duration, 240);
  assert.equal(calls[0].args.includes("--no-playlist"), true);
  assert.equal(calls[0].args.includes("--js-runtimes"), true);
  assert.equal(calls[0].args.includes("--remote-components"), true);

  const privateSource = new YouTubeSource({ runner: async () => ({
    stdout: JSON.stringify({ id: "dQw4w9WgXcQ", availability: "private", duration: 240 }),
    stderr: "",
  }) });
  await assert.rejects(() => privateSource.inspect("https://youtu.be/dQw4w9WgXcQ"), /youtube_video_not_public/);
});

test("YouTube adapter can use an explicitly configured browser cookie source", async () => {
  const calls = [];
  const source = new YouTubeSource({
    cookiesFromBrowser: "chrome",
    runner: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: JSON.stringify({ id: "dQw4w9WgXcQ", availability: "public", duration: 30, title: "Own video" }), stderr: "" };
    },
  });
  await source.inspect("https://youtu.be/dQw4w9WgXcQ");
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--cookies-from-browser"), calls[0].args.indexOf("--cookies-from-browser") + 2), ["--cookies-from-browser", "chrome"]);
});

test("YouTube adapter keeps configured paths valid when download changes cwd", async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "dubroom-provider-test-"));
  const cookiesFile = path.join(fixtureDirectory, "youtube-cookies.txt");
  await writeFile(cookiesFile, "", "utf8");
  const calls = [];
  const source = new YouTubeSource({
    executable: "./backend/tools/yt-dlp.exe",
    cookiesFile,
    runner: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: path.join(options.cwd, "project.mp4"), stderr: "" };
    },
  });
  try {
    const targetDirectory = path.join(process.cwd(), "work", "project");
    await source.download("https://youtu.be/dQw4w9WgXcQ", targetDirectory, "project");

    assert.equal(path.isAbsolute(calls[0].executable), true);
    const cookiePath = calls[0].args[calls[0].args.indexOf("--cookies") + 1];
    assert.equal(path.isAbsolute(cookiePath), true);
    assert.notEqual(cookiePath, cookiesFile);
    assert.equal(calls[0].options.cwd, targetDirectory);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("media adapter extracts one lossless timing master", async () => {
  const calls = [];
  const media = new MediaTools({ runner: async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: "", stderr: "" };
  } });
  await media.extractAudio("source.mp4", "master.wav");
  assert.deepEqual(calls[0].args.slice(-8), ["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "master.wav"]);
});

test("media adapter normalizes recommendation posters to 16:9 JPEG", async () => {
  const calls = [];
  const media = new MediaTools({ runner: async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: "", stderr: "" };
  } });
  await media.normalizePoster("preview.png", "poster.jpg");
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[calls[0].args.indexOf("-vf") + 1], /scale=1280:720.*crop=1280:720/);
  assert.deepEqual(calls[0].args.slice(-3), ["-q:v", "3", "poster.jpg"]);
});

test("ElevenLabs adapter requests two stems and role-free word timestamps", async () => {
  const calls = [];
  const client = new ElevenLabsClient({
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, fields: init.body ? Object.fromEntries(init.body.entries()) : {} });
      if (String(url).includes("user/subscription")) return Response.json({ tier: "creator", status: "active" });
      if (String(url).includes("stem-separation")) return new Response(new Uint8Array([1, 2, 3]));
      return Response.json({ words: [] });
    },
  });
  const audio = new Blob([new Uint8Array([0, 1])], { type: "audio/wav" });
  assert.equal((await client.getSubscription()).tier, "creator");
  const stems = await client.separateStems({ audio });
  assert.deepEqual([...stems], [1, 2, 3]);
  assert.equal(calls[1].fields.stem_variation_id, "two_stems_v1");
  assert.match(calls[1].url, /output_format=mp3_44100_128/);

  await client.transcribe({ audio, projectId: "project-1" });
  assert.equal(calls[2].fields.model_id, "scribe_v2");
  assert.equal(calls[2].fields.timestamps_granularity, "word");
  assert.equal(calls[2].fields.diarize, "false");
  assert.equal(calls[2].fields.tag_audio_events, "false");
  assert.deepEqual(JSON.parse(calls[2].fields.webhook_metadata), { projectId: "project-1" });
});
