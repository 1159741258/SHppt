import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { RuntimeError, publicError, redactText } from "../src/errors.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..");
const defaultProject = path.join(repositoryRoot, "tests", "fixtures", "p0-deck");

const options = parseArgs(process.argv.slice(2));
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-preview-probe-"));
const evidenceDirectory = options.evidenceDirectory || path.join(runRoot, "evidence");
await fs.mkdir(evidenceDirectory, { recursive: true });
const stateDirectory = path.join(runRoot, "state");
const daemonPath = path.join(repositoryRoot, "src", "daemon.mjs");
const daemonArguments = [
  daemonPath,
  "--content-root", options.project,
  "--port", "0",
  "--state-dir", stateDirectory,
  "--evidence-dir", evidenceDirectory,
  "--browser", options.browser,
  "--build", options.build
];
const evidence = {
  schemaVersion: 1,
  command: "node tools/preview-probe.mjs",
  result: "failed",
  buildIdentity: options.build,
  browser: options.browser,
  viewport: { width: options.width, height: options.height },
  dpr: options.dpr,
  fixtureHash: null,
  projectId: null,
  fileIndexVersion: null,
  assertions: [],
  previews: [],
  diagnostics: null,
  createdAt: new Date().toISOString()
};

let daemon;
try {
  daemon = spawn(process.execPath, daemonArguments, { cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stderr = { value: "" };
  daemon.stderr.on("data", (chunk) => { stderr.value = `${stderr.value}${chunk.toString("utf8")}`.slice(-4096); });
  const started = await waitForDaemon(daemon.stdout, daemon, 20000);
  if (!started.origin) throw new RuntimeError("DAEMON_START_FAILED", "The Local Daemon did not return a loopback origin.");
  const health = await fetchJson(`${started.origin}/api/health`);
  const project = await fetchJson(`${started.origin}/api/project`);
  evidence.projectId = project.project.projectId;
  evidence.fileIndexVersion = project.project.fileIndexVersion;
  evidence.fixtureHash = project.project.fixtureHash;
  assert(project.project.type === "html-deck", "project-type");
  assert(project.project.slides.length === 2, "two-slides");
  assert(project.project.files.some((file) => file.kind === "font"), "local-font-indexed");
  assert(!JSON.stringify(project).match(/[A-Za-z]:\\|\\\\/), "public-response-has-no-absolute-path");
  evidence.assertions.push("daemon-health", "http-json-project", "sse-subscription");
  assert(health.project.projectId === evidence.projectId, "health-project-identity");
  await consumeSse(started.origin);

  for (const slide of project.project.slides) {
    const preview = await fetchJson(`${started.origin}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: evidence.projectId,
        fileIndexVersion: evidence.fileIndexVersion,
        slideId: slide.slideId,
        viewport: { width: options.width, height: options.height },
        dpr: options.dpr
      })
    });
    assert(preview.preview.status === "ready", `${slide.slideId}-preview-ready`);
    assert(preview.preview.renderingIdentity.browser, `${slide.slideId}-browser-recorded`);
    assert(preview.preview.renderingIdentity.renderingMode === "cdp-headless", `${slide.slideId}-render-mode-recorded`);
    assert(preview.preview.renderingIdentity.fontHash, `${slide.slideId}-font-recorded`);
    assert(preview.preview.renderingIdentity.fixtureHash === evidence.fixtureHash, `${slide.slideId}-fixture-recorded`);
    assert(preview.preview.observation?.activeSlideId === slide.slideId, `${slide.slideId}-bridge-observation`);
    const screenshot = await fetch(`${started.origin}/api/evidence/${preview.screenshot.assetId}`);
    const screenshotBytes = Buffer.from(await screenshot.arrayBuffer());
    assert(screenshot.ok && screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${slide.slideId}-png-screenshot`);
    evidence.previews.push({
      slideId: slide.slideId,
      status: preview.preview.status,
      assetId: preview.screenshot.assetId,
      screenshotSha256: preview.screenshot.sha256,
      byteLength: screenshotBytes.length,
      evidenceManifestId: preview.evidenceManifest.manifestId
    });
  }
  evidence.assertions.push("bridge-handshake", "non-empty-slide", "dom-observation", "png-screenshot", "rendering-metadata");
  evidence.result = "passed";
  evidence.diagnostics = { daemonStatus: health.status, scanError: null };
} catch (error) {
  evidence.result = "failed";
  evidence.diagnostics = {
    error: publicError(error),
    stderr: redactText(stderr.value)
  };
} finally {
  if (daemon && daemon.exitCode === null) {
    try { daemon.kill(); } catch {}
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
}

const manifestPath = path.join(evidenceDirectory, `probe-${Date.now()}.json`);
evidence.exitCode = evidence.result === "passed" ? 0 : 1;
await fs.writeFile(manifestPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ result: evidence.result, manifestPath, runRoot, assertions: evidence.assertions, previews: evidence.previews })}\n`);
if (evidence.result !== "passed") process.exitCode = 1;

function parseArgs(argv) {
  const parsed = { project: defaultProject, browser: "chrome", width: 1280, height: 720, dpr: 1, build: "probe" };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--project") parsed.project = path.resolve(value);
    else if (argument === "--evidence-dir") parsed.evidenceDirectory = path.resolve(value);
    else if (argument === "--browser") parsed.browser = value;
    else if (argument === "--width") parsed.width = Number(value);
    else if (argument === "--height") parsed.height = Number(value);
    else if (argument === "--dpr") parsed.dpr = Number(value);
    else if (argument === "--build") parsed.build = value;
    if (["--project", "--evidence-dir", "--browser", "--width", "--height", "--dpr", "--build"].includes(argument)) index++;
  }
  return parsed;
}

function assert(condition, name) {
  if (!condition) throw new RuntimeError("PROBE_ASSERTION_FAILED", `Probe assertion failed: ${name}.`, { assertion: name });
}

async function waitForDaemon(stdout, child, timeoutMs) {
  const lineReader = readline.createInterface({ input: stdout });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { lineReader.close(); reject(new RuntimeError("DAEMON_START_TIMEOUT", "The Local Daemon did not start in time.")); }, timeoutMs);
    lineReader.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.event === "listening") {
          clearTimeout(timer);
          lineReader.close();
          resolve(message);
        }
      } catch {
        // The daemon only emits JSON, but a stray line is not a credential-bearing diagnostic.
      }
    });
    child.once("error", (error) => { clearTimeout(timer); lineReader.close(); reject(new RuntimeError("DAEMON_START_FAILED", error.message)); });
    child.once("exit", (code) => { if (code !== null && code !== 0) { clearTimeout(timer); lineReader.close(); reject(new RuntimeError("DAEMON_START_FAILED", "The Local Daemon exited before it was ready.")); } });
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new RuntimeError(body.error?.code || "HTTP_REQUEST_FAILED", body.error?.message || "The HTTP request failed.", body.error?.details || {});
  return body;
}

async function consumeSse(origin) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
  assert(response.ok && response.headers.get("content-type")?.includes("text/event-stream"), "sse-content-type");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert(Buffer.from(first.value || []).toString("utf8").includes("subscription.snapshot"), "sse-snapshot");
  controller.abort();
  reader.releaseLock();
}
