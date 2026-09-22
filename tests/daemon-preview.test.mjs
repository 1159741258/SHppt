import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "p0-deck");
const daemonPath = path.join(repositoryRoot, "src", "daemon.mjs");

test("HTTP-01 renders both fixed Slides through the Bridge and evidence seam", { timeout: 120000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-daemon-test-"));
  const projectRoot = path.join(runRoot, "project");
  const stateDirectory = path.join(runRoot, "state");
  const evidenceDirectory = path.join(runRoot, "evidence");
  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  const daemon = spawn(process.execPath, [
    daemonPath,
    "--content-root", projectRoot,
    "--port", "0",
    "--state-dir", stateDirectory,
    "--evidence-dir", evidenceDirectory,
    "--browser", "chrome",
    "--build", "node-test"
  ], { cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  daemon.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096); });
  try {
    const started = await waitForListening(daemon);
    const projectResponse = await requestJson(`${started.origin}/api/project`);
    const project = projectResponse.project;
    assert.equal(project.slides.length, 2);
    assert.equal(project.files.filter((file) => file.kind === "font").length, 1);
    assert.doesNotMatch(JSON.stringify(projectResponse), /[A-Za-z]:\\|\\\\/);

    const eventResponse = await fetch(`${started.origin}/api/events`);
    assert.equal(eventResponse.status, 200);
    assert.match(eventResponse.headers.get("content-type"), /text\/event-stream/);
    const reader = eventResponse.body.getReader();
    const eventChunk = await reader.read();
    assert.match(Buffer.from(eventChunk.value).toString("utf8"), /subscription\.snapshot/);
    await reader.cancel();

    for (const slide of project.slides) {
      const previewResponse = await requestJson(`${started.origin}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.projectId,
          fileIndexVersion: project.fileIndexVersion,
          slideId: slide.slideId,
          viewport: { width: 1280, height: 720 },
          dpr: 1
        })
      });
      assert.equal(previewResponse.preview.status, "ready");
      assert.equal(previewResponse.preview.observation.activeSlideId, slide.slideId);
      assert.ok(previewResponse.preview.observation.elements.every((element) => Number.isFinite(element.rect.x) && Number.isFinite(element.rect.y)));
      assert.equal(previewResponse.preview.renderingIdentity.viewport.width, 1280);
      assert.equal(previewResponse.preview.renderingIdentity.dpr, 1);
      assert.ok(previewResponse.preview.renderingIdentity.browser);
      assert.ok(previewResponse.preview.renderingIdentity.fontHash);
      assert.ok(previewResponse.preview.renderingIdentity.fixtureHash);
      const screenshotResponse = await fetch(`${started.origin}/api/evidence/${previewResponse.screenshot.assetId}`);
      const screenshot = Buffer.from(await screenshotResponse.arrayBuffer());
      assert.equal(screenshotResponse.status, 200);
      assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(screenshot.length > 1000);
    }

    const staleResponse = await fetch(`${started.origin}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: "sha256:stale", slideId: "cover" })
    });
    const staleBody = await staleResponse.json();
    assert.equal(staleResponse.status, 400);
    assert.equal(staleBody.error.code, "PROJECT_VERSION_MISMATCH");

    const manifests = await findFiles(evidenceDirectory, "manifest-");
    assert.equal(manifests.length, 2);
    for (const manifestPath of manifests) {
      const manifest = await fs.readFile(manifestPath, "utf8");
      assert.doesNotMatch(manifest, /contentRoot|[A-Za-z]:\\|\\\\/i);
    }
  } catch (error) {
    error.message = `${error.message}\nDaemon stderr: ${stderr}`;
    throw error;
  } finally {
    if (daemon.exitCode === null) {
      try { daemon.kill(); } catch {}
      await new Promise((resolve) => daemon.once("exit", resolve));
    }
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

async function waitForListening(daemon) {
  const lines = readline.createInterface({ input: daemon.stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon start timeout")), 20000);
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.event === "listening") {
          clearTimeout(timer);
          lines.close();
          resolve(message);
        }
      } catch {}
    });
    daemon.once("error", reject);
    daemon.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        lines.close();
        reject(new Error(`daemon exited with ${code}`));
      }
    });
  });
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function findFiles(root, prefix) {
  const output = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await findFiles(fullPath, prefix));
    else if (entry.name.startsWith(prefix)) output.push(fullPath);
  }
  return output;
}
