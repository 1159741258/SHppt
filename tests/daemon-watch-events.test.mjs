import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalDaemon } from "../src/daemon.mjs";

const fixtureRoot = path.resolve("tests/fixtures/p0-deck");

test("HTTP-03 keeps multiple subscribers and PreviewSessions consistent through a stable change", { timeout: 30000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-watch-http-"));
  const projectRoot = path.join(runRoot, "project");
  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  const registry = new FakeWatcherRegistry();
  const daemon = new LocalDaemon({
    contentRoot: projectRoot,
    stateDirectory: path.join(runRoot, "state"),
    evidenceDirectory: path.join(runRoot, "evidence"),
    watcherRegistry: registry,
    stabilityWindowMs: 10000,
    maxStabilityWaitMs: 20000
  });
  const readers = [];
  try {
    const started = await daemon.start();
    const firstStream = await openEventStream(started.origin);
    const secondStream = await openEventStream(started.origin);
    readers.push(firstStream.reader, secondStream.reader);
    const firstSnapshot = await firstStream.next("subscription.snapshot");
    const secondSnapshot = await secondStream.next("subscription.snapshot");
    assert.equal(firstSnapshot.data.eventId, secondSnapshot.data.eventId);

    const version = started.snapshot.fileIndexVersion;
    daemon.previews.set("preview-1", readyPreview("preview-1", "iframe-1", version));
    daemon.previews.set("preview-2", readyPreview("preview-2", "iframe-2", version));
    registry.emit({ eventType: "change", path: "styles/deck.css", origin: "external" });

    const pendingOne = await firstStream.next("project.file-change-pending");
    const pendingTwo = await secondStream.next("project.file-change-pending");
    assert.equal(pendingOne.data.eventId, pendingTwo.data.eventId);
    assert.equal(daemon.previews.get("preview-1").status, "stale");
    assert.equal(daemon.previews.get("preview-2").status, "stale");

    await fs.appendFile(path.join(projectRoot, "styles", "deck.css"), "\n/* stable change */\n", "utf8");
    await daemon.projectObserver.check();
    await daemon.projectObserver.check();
    const changedOne = await firstStream.next("project.file-changed");
    const changedTwo = await secondStream.next("project.file-changed");
    assert.equal(changedOne.data.eventId, changedTwo.data.eventId);
    assert.equal(changedOne.data.sequence, pendingOne.data.sequence + 3);
    assert.notEqual(changedOne.data.fileIndexVersion, version);
    assert.deepEqual(changedOne.data.payload.paths, ["styles/deck.css"]);
    assert.doesNotMatch(JSON.stringify(changedOne.data), /contentRoot|[A-Za-z]:\\|\\\\/i);

    await firstStream.reader.cancel();
    readers.splice(readers.indexOf(firstStream.reader), 1);
    const replay = await openEventStream(started.origin, pendingOne.data.eventId);
    readers.push(replay.reader);
    const replayedStale = await replay.next("preview.stale");
    const replayedChange = await replay.next("project.file-changed");
    assert.equal(replayedStale.data.sequence, pendingOne.data.sequence + 1);
    assert.equal(replayedChange.data.eventId, changedOne.data.eventId);
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => {});
    await daemon.stop();
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test("HTTP-04 preserves the last snapshot when a stable deletion breaks the Deck", { timeout: 30000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-delete-http-"));
  const projectRoot = path.join(runRoot, "project");
  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  const registry = new FakeWatcherRegistry();
  const daemon = new LocalDaemon({
    contentRoot: projectRoot,
    stateDirectory: path.join(runRoot, "state"),
    evidenceDirectory: path.join(runRoot, "evidence"),
    watcherRegistry: registry,
    stabilityWindowMs: 10000,
    maxStabilityWaitMs: 20000
  });
  let stream;
  try {
    const started = await daemon.start();
    stream = await openEventStream(started.origin);
    await stream.next("subscription.snapshot");
    const version = started.snapshot.fileIndexVersion;
    await fs.rm(path.join(projectRoot, "assets", "fixture-mark.svg"));
    registry.emit({ eventType: "rename", path: "assets/fixture-mark.svg", origin: "external" });
    await daemon.projectObserver.check();
    await daemon.projectObserver.check();

    const failure = await stream.next("project.scan-failed");
    assert.equal(failure.data.fileIndexVersion, version);
    assert.equal(failure.data.payload.error.code, "PROJECT_SCAN_FAILED");
    const projectResponse = await fetch(`${started.origin}/api/project`);
    const project = await projectResponse.json();
    assert.equal(projectResponse.status, 200);
    assert.equal(project.project.fileIndexVersion, version);
    assert.equal(project.preview.state, "stale");
    assert.equal(project.scanError.code, "PROJECT_SCAN_FAILED");
  } finally {
    await stream?.reader.cancel().catch(() => {});
    await daemon.stop();
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test("HTTP-05 exposes an expired preview scope as expired instead of ready", { timeout: 30000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-expired-http-"));
  const registry = new FakeWatcherRegistry();
  const daemon = new LocalDaemon({
    contentRoot: fixtureRoot,
    stateDirectory: path.join(runRoot, "state"),
    evidenceDirectory: path.join(runRoot, "evidence"),
    watcherRegistry: registry
  });
  try {
    const started = await daemon.start();
    const version = started.snapshot.fileIndexVersion;
    daemon.previews.set("expired-preview", readyPreview("expired-preview", "expired-frame", version));
    daemon.previewScopes.set("expired-scope", {
      scopeId: "expired-scope",
      projectId: started.projectId,
      fileIndexVersion: version,
      previewSessionId: "expired-preview",
      iframeInstanceId: "expired-frame",
      expiresAt: 0
    });
    const response = await fetch(`${started.origin}/renderer/expired-scope`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "PREVIEW_SCOPE_EXPIRED");
    assert.equal(daemon.previews.get("expired-preview").status, "expired");
    assert.equal(daemon.previews.get("expired-preview").reason, "preview-scope-expired");
  } finally {
    await daemon.stop();
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

function readyPreview(previewSessionId, iframeInstanceId, fileIndexVersion) {
  return {
    previewSessionId,
    iframeInstanceId,
    projectId: "project",
    fileIndexVersion,
    slideId: "cover",
    status: "ready",
    state: "ready",
    reason: null,
    lastReadyFileIndexVersion: fileIndexVersion
  };
}

class FakeWatcherRegistry {
  acquire(_root, listener) {
    this.listener = listener;
    return { release: () => { this.listener = null; } };
  }

  emit(event) {
    this.listener(event);
  }
}

async function openEventStream(origin, lastEventId = null) {
  const response = await fetch(`${origin}/api/events`, { headers: lastEventId ? { "Last-Event-ID": lastEventId } : {} });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = "";
  const pending = [];
  return {
    reader,
    async next(expectedType) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const match = pending.findIndex((event) => event.type === expectedType);
        if (match >= 0) return pending.splice(match, 1)[0];
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += Buffer.from(chunk.value).toString("utf8");
        const records = buffer.split("\n\n");
        buffer = records.pop() || "";
        for (const record of records) {
          const type = record.match(/^event: ([^\r\n]+)/m)?.[1];
          const data = record.match(/^data: ([^\r\n]+)/m)?.[1];
          if (type && data) pending.push({ type, data: JSON.parse(data) });
        }
      }
      throw new Error(`Timed out waiting for ${expectedType}.`);
    }
  };
}
