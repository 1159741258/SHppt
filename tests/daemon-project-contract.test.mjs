import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalDaemon } from "../src/daemon.mjs";

const fixtureRoot = path.resolve("tests/fixtures/p0-deck");

test("HTTP-02 exposes Project-relative data and publishes preview loading/error states", { timeout: 30000 }, async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-http-contract-"));
  const daemon = new LocalDaemon({
    contentRoot: fixtureRoot,
    stateDirectory: path.join(runRoot, "state"),
    evidenceDirectory: path.join(runRoot, "evidence"),
    browserPath: path.join(runRoot, "missing-browser.exe")
  });
  let reader;
  try {
    const started = await daemon.start();
    const stream = await fetch(`${started.origin}/api/events`);
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    const nextEvent = createEventReader(reader);
    const initial = await nextEvent("subscription.snapshot");
    assert.doesNotMatch(JSON.stringify(initial), /contentRoot|[A-Za-z]:\\|\\\\/i);

    const projectResponse = await fetch(`${started.origin}/api/project`);
    const projectBody = await projectResponse.json();
    assert.equal(projectResponse.status, 200);
    assert.doesNotMatch(JSON.stringify(projectBody), /contentRoot|[A-Za-z]:\\|\\\\/i);
    const project = projectBody.project;

    const response = await fetch(`${started.origin}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.projectId, fileIndexVersion: project.fileIndexVersion, slideId: "cover" })
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.preview.status, "error");
    assert.equal(body.preview.state, "error");
    assert.match(body.preview.rendererUrl, new RegExp(`^${started.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/renderer/`));
    assert.doesNotMatch(body.preview.rendererUrl, /contentRoot|[A-Za-z]:\\|\\\\/i);
    const rendererResponse = await fetch(body.preview.rendererUrl);
    const rendererHtml = await rendererResponse.text();
    assert.equal(rendererResponse.status, 200);
    assert.match(rendererHtml, /preview-status/);
    assert.match(rendererHtml, /__shpptSelectSlide/);
    assert.doesNotMatch(rendererHtml, /contentRoot|[A-Za-z]:\\|\\\\/i);
    assert.match(body.error.code, /^RENDERER_/);
    assert.doesNotMatch(JSON.stringify(body), /contentRoot|[A-Za-z]:\\|\\\\/i);

    const loading = await nextEvent("preview.loading");
    const failure = await nextEvent("preview.error");
    assert.equal(loading.data.projectId, project.projectId);
    assert.equal(loading.data.fileIndexVersion, project.fileIndexVersion);
    assert.equal(loading.data.payload.state, "loading");
    assert.equal(failure.data.projectId, project.projectId);
    assert.equal(failure.data.fileIndexVersion, project.fileIndexVersion);
    assert.equal(failure.data.payload.state, "error");
    assert.doesNotMatch(JSON.stringify({ loading, failure }), /contentRoot|[A-Za-z]:\\|\\\\/i);
  } finally {
    await reader?.cancel().catch(() => {});
    await daemon.stop();
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

function createEventReader(reader) {
  let buffer = "";
  const pending = [];
  return async function readEvent(expectedType) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const matching = pending.findIndex((event) => event.type === expectedType);
      if (matching >= 0) return pending.splice(matching, 1)[0];
      const next = await reader.read();
      if (next.done) break;
      buffer += Buffer.from(next.value).toString("utf8");
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const eventText of events) {
        const type = eventText.match(/^event: ([^\r\n]+)/m)?.[1];
        const data = eventText.match(/^data: ([^\r\n]+)/m)?.[1];
        if (type && data) pending.push({ type, data: JSON.parse(data) });
      }
    }
    throw new Error(`Timed out waiting for SSE event ${expectedType}.`);
  };
}
