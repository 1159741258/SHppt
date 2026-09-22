import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalDaemon } from "../src/daemon.mjs";
import { CAPTURE_BOX, CAPTURE_CLICK } from "../src/annotation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "p0-deck");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_HASH = `sha256:${createHash("sha256").update(PNG).digest("hex")}`;

test("HTTP-03 saves click and box AnnotationV1 captures and rejects invalid Bridge messages", { timeout: 30000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-annotation-test-"));
  const daemon = new LocalDaemon({ contentRoot: fixtureRoot, port: 0, stateDirectory: path.join(runRoot, "state"), evidenceDirectory: path.join(runRoot, "evidence"), buildIdentity: "annotation-test" });
  try {
    const started = await daemon.start();
    const project = started.snapshot;
    const cover = project.slides.find((slide) => slide.slideId === "cover");
    const scope = installScope(daemon, project, cover, started.origin);
    daemon.captureAnnotationEvidence = async ({ scope: activeScope }) => {
      const assetId = randomUUID();
      const assetPath = path.join(runRoot, "evidence", "annotations", `${assetId}.png`);
      await fs.mkdir(path.dirname(assetPath), { recursive: true });
      await fs.writeFile(assetPath, PNG);
      return {
        assetPath,
        screenshot: { assetId, mediaType: "image/png", byteLength: PNG.length, sha256: PNG_HASH, width: 1, height: 1, overlay: true },
        evidenceManifest: { manifestId: `manifest-${assetId}`, result: "passed", command: "annotation-capture", slideId: activeScope.slideId }
      };
    };

    const eventsResponse = await fetch(`${started.origin}/api/events`);
    assert.equal(eventsResponse.status, 200);
    const eventReader = eventsResponse.body.getReader();
    const initial = await eventReader.read();
    assert.match(Buffer.from(initial.value).toString("utf8"), /subscription\.snapshot/);

    const click = capture(started.origin, project, scope, {
      type: CAPTURE_CLICK,
      sequence: 2,
      messageId: "iframe-1:capture:2",
      stableElementId: "cover-title",
      geometry: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
      domContext: { target: context("cover-title", { x: 0.1, y: 0.2, width: 0.5, height: 0.1 }), ancestors: [] }
    });
    const accepted = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: click }) });
    assert.equal(accepted.ack.status, "accepted");
    assert.equal(accepted.annotation.type, "click");
    assert.equal(accepted.annotation.target.stableElementId, "cover-title");
    assert.equal(accepted.annotation.sourcePath, "index.html");
    assert.equal(accepted.annotation.contentHash, project.files.find((file) => file.path === "index.html").contentHash);
    assert.equal(accepted.annotation.evidence.screenshot.overlay, true);

    const annotationEvent = await readUntil(eventReader, "annotation.captured");
    assert.match(annotationEvent, /annotation\.captured/);

    const duplicate = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: click }) });
    assert.equal(duplicate.ack.status, "duplicate");
    assert.equal(duplicate.ack.annotationId, accepted.ack.annotationId);

    const box = capture(started.origin, project, scope, {
      type: CAPTURE_BOX,
      sequence: 3,
      messageId: "iframe-1:capture:3",
      stableElementIds: ["cover-eyebrow", "cover-title"],
      stableElementId: undefined,
      geometry: { x: 0.05, y: 0.05, width: 0.6, height: 0.4 },
      domContext: { members: [context("cover-eyebrow", { x: 0.05, y: 0.05, width: 0.15, height: 0.05 }), context("cover-title", { x: 0.1, y: 0.2, width: 0.5, height: 0.1 })], ancestors: [] }
    });
    const boxResult = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: box }) });
    assert.equal(boxResult.ack.status, "accepted");
    assert.deepEqual(boxResult.annotation.target.stableElementIds, ["cover-eyebrow", "cover-title"]);

    const outOfOrder = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: { ...click, messageId: "iframe-1:capture:2b", stableElementId: "cover-eyebrow" } }) });
    assert.equal(outOfOrder.ack.status, "rejected");
    assert.equal(outOfOrder.ack.error.code, "BRIDGE_SEQUENCE_OUT_OF_ORDER");

    const unknownVersion = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: { ...box, messageId: "iframe-1:capture:4", sequence: 4, version: 2 } }) });
    assert.equal(unknownVersion.ack.error.code, "BRIDGE_PROTOCOL_UNSUPPORTED");

    const stale = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: { ...box, messageId: "iframe-1:capture:5", sequence: 5, fileIndexVersion: `sha256:${"f".repeat(64)}` } }) });
    assert.equal(stale.ack.error.code, "PROJECT_VERSION_MISMATCH");

    const oversized = await requestJson(`${started.origin}/api/annotations`, { method: "POST", body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, capture: { ...box, messageId: "iframe-1:capture:6", sequence: 6, intent: "x".repeat(140000) } }) });
    assert.equal(oversized.ack.error.code, "ANNOTATION_PAYLOAD_TOO_LARGE");

    const list = await requestJson(`${started.origin}/api/annotations?projectId=${encodeURIComponent(project.projectId)}&fileIndexVersion=${encodeURIComponent(project.fileIndexVersion)}`);
    assert.equal(list.annotations.length, 2);
    assert.equal((await requestJson(`${started.origin}/api/annotations/${accepted.ack.annotationId}`)).annotation.annotationId, accepted.ack.annotationId);
    assert.doesNotMatch(JSON.stringify(list), /contentRoot|[A-Za-z]:\\|\\\\/i);
  } finally {
    await daemon.stop();
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

function installScope(daemon, project, slide, origin) {
  const scope = {
    scopeId: "scope-1",
    projectId: project.projectId,
    fileIndexVersion: project.fileIndexVersion,
    entryPath: project.entryPath,
    slideId: slide.slideId,
    previewSessionId: "session-1",
    iframeInstanceId: "iframe-1",
    bridgeNonce: "nonce-1",
    origin,
    expiresAt: Date.now() + 60000,
    viewport: { width: 1280, height: 720 },
    dpr: 1,
    lastBridgeSequence: 1
  };
  daemon.previewScopes.set(scope.scopeId, scope);
  return scope;
}

function capture(origin, project, scope, overrides) {
  return {
    protocol: "shppt-bridge",
    version: 1,
    source: "preview",
    transport: "MessagePort",
    origin,
    nonce: scope.bridgeNonce,
    projectId: project.projectId,
    fileIndexVersion: project.fileIndexVersion,
    previewSessionId: scope.previewSessionId,
    iframeInstanceId: scope.iframeInstanceId,
    slideId: scope.slideId,
    sequence: 2,
    messageId: "iframe-1:capture:2",
    type: CAPTURE_CLICK,
    geometry: { x: 0.1, y: 0.2, width: 0.25, height: 0.12 },
    stableElementId: "cover-title",
    domContext: { target: context("cover-title", { x: 0.1, y: 0.2, width: 0.25, height: 0.12 }), ancestors: [] },
    ...overrides
  };
}

function context(stableElementId, rect) {
  return { stableElementId, tagName: "div", role: "", text: stableElementId, rect, ancestors: [] };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  return response.json();
}

async function readUntil(reader, text) {
  let output = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE event timeout")), 5000))
    ]);
    if (result.done) break;
    output += Buffer.from(result.value).toString("utf8");
    if (output.includes(text)) return output;
  }
  throw new Error(`SSE event not found: ${text}`);
}
