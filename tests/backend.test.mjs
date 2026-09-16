import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const root = new URL("../", import.meta.url);
const port = 54000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForBackend(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Backend exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener may need a few milliseconds to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Backend did not become ready");
}

test("backend exposes scoring and validates render jobs", async () => {
  const child = spawn(process.execPath, ["backend/server.cjs"], {
    cwd: root,
    env: { ...process.env, DUBROOM_PORT: String(port) },
    stdio: "ignore",
  });

  try {
    await waitForBackend(child);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ready",
      service: "dubroom-backend",
      version: "2.0",
      score: true,
      render: true,
      format: "mp4",
    });

    const forbidden = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(forbidden.status, 403);

    const score = await fetch(`${baseUrl}/api/score`, {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(score.status, 200);
    assert.equal((await score.json()).score, 100);

    const invalid = await fetch(`${baseUrl}/api/render/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration: 0, cues: [] }),
    });
    assert.equal(invalid.status, 400);

    const created = await fetch(`${baseUrl}/api/render/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        duration: 2,
        videoName: "scene.mp4",
        cues: [{ id: "line-1", start: 0.25, end: 1.5 }],
      }),
    });
    assert.equal(created.status, 201);
    const { jobId } = await created.json();
    assert.match(jobId, /^[0-9a-f-]{36}$/i);

    const status = await fetch(`${baseUrl}/api/render/jobs/${jobId}/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, "uploading");

    const removed = await fetch(`${baseUrl}/api/render/jobs/${jobId}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { deleted: true });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});
