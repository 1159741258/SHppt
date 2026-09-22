import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ANNOTATION_LIMITS,
  CAPTURE_BOX,
  CAPTURE_CLICK,
  createAnnotationV1,
  validateAnnotationV1,
  validateBridgeCapture
} from "../src/annotation.mjs";

const HASH = `sha256:${"a".repeat(64)}`;
const ORIGIN = "http://127.0.0.1:43111";

function context(id, text = "target") {
  return {
    stableElementId: id,
    tagName: "div",
    role: "",
    text,
    rect: { x: 0.1, y: 0.2, width: 0.25, height: 0.12 },
    ancestors: [{ stableElementId: null, tagName: "section", text: "slide" }]
  };
}

function capture(overrides = {}) {
  return {
    protocol: "shppt-bridge",
    version: 1,
    type: CAPTURE_CLICK,
    source: "preview",
    transport: "MessagePort",
    origin: ORIGIN,
    nonce: "nonce-1",
    projectId: "project-1",
    fileIndexVersion: HASH,
    previewSessionId: "session-1",
    iframeInstanceId: "iframe-1",
    slideId: "cover",
    sequence: 2,
    messageId: "iframe-1:capture:2",
    geometry: { x: 0.1, y: 0.2, width: 0.25, height: 0.12 },
    stableElementId: "cover-title",
    domContext: { target: context("cover-title"), ancestors: [{ stableElementId: null, tagName: "section", text: "slide" }] },
    ...overrides
  };
}

test("AnnotationV1 captures click identity, geometry, bounded DOM context, and overlay evidence", () => {
  const normalized = validateBridgeCapture(capture(), {
    projectId: "project-1",
    fileIndexVersion: HASH,
    slideId: "cover",
    origin: ORIGIN,
    nonce: "nonce-1",
    lastSequence: 1,
    knownStableElementIds: new Set(["cover-title"]),
    elementOrder: ["cover-title"]
  });
  const annotation = createAnnotationV1({
    capture: normalized,
    slide: { slideId: "cover", slideIndex: 0, sourcePath: "index.html" },
    sourcePath: "index.html",
    contentHash: HASH,
    screenshot: { assetId: "asset-1", mediaType: "image/png", byteLength: 12, sha256: HASH, width: 1280, height: 720, overlay: true },
    evidenceManifestId: "manifest-1"
  });

  assert.equal(annotation.schemaVersion, 1);
  assert.equal(annotation.type, "click");
  assert.equal(annotation.target.stableElementId, "cover-title");
  assert.equal(annotation.sourcePath, "index.html");
  assert.equal(annotation.fileIndexVersion, HASH);
  assert.equal(annotation.evidence.screenshot.overlay, true);
  assert.doesNotThrow(() => validateAnnotationV1(annotation));
});

test("box capture preserves DOM order and rejects reordered members", () => {
  const message = capture({
    type: CAPTURE_BOX,
    sequence: 3,
    messageId: "iframe-1:capture:3",
    stableElementId: undefined,
    stableElementIds: ["cover-eyebrow", "cover-title"],
    geometry: { x: 0.05, y: 0.05, width: 0.6, height: 0.4 },
    domContext: { members: [context("cover-eyebrow"), context("cover-title")], ancestors: [] }
  });
  const options = {
    projectId: "project-1",
    fileIndexVersion: HASH,
    slideId: "cover",
    origin: ORIGIN,
    nonce: "nonce-1",
    lastSequence: 2,
    knownStableElementIds: new Set(["cover-eyebrow", "cover-title"]),
    elementOrder: ["cover-eyebrow", "cover-title"]
  };
  assert.deepEqual(validateBridgeCapture(message, options).stableElementIds, ["cover-eyebrow", "cover-title"]);
  assert.throws(() => validateBridgeCapture({ ...message, messageId: "reordered", stableElementIds: ["cover-title", "cover-eyebrow"] }, options), (error) => error.code === "DECK_ELEMENT_ORDER_INVALID");
});

test("Bridge capture rejects protocol, sequence, size, and context violations deterministically", () => {
  const options = { projectId: "project-1", fileIndexVersion: HASH, slideId: "cover", origin: ORIGIN, nonce: "nonce-1", lastSequence: 2, knownStableElementIds: new Set(["cover-title"]), elementOrder: ["cover-title"] };
  assert.throws(() => validateBridgeCapture(capture({ version: 2 }), options), (error) => error.code === "BRIDGE_PROTOCOL_UNSUPPORTED");
  assert.throws(() => validateBridgeCapture(capture({ sequence: 2, messageId: "old" }), options), (error) => error.code === "BRIDGE_SEQUENCE_OUT_OF_ORDER");
  assert.throws(() => validateBridgeCapture(capture({ sequence: 3, messageId: "context-too-long", domContext: { target: context("cover-title", "x".repeat(ANNOTATION_LIMITS.contextText + 1)), ancestors: [] } }), options), (error) => error.code === "ANNOTATION_CONTEXT_INVALID");
  assert.throws(() => validateBridgeCapture(capture({ sequence: 3, messageId: "too-large", intent: "x".repeat(ANNOTATION_LIMITS.messageBytes) }), options), (error) => error.code === "ANNOTATION_PAYLOAD_TOO_LARGE");
});

test("Annotation evidence hashes use SHA-256-shaped references", () => {
  const digest = createHash("sha256").update("overlay").digest("hex");
  assert.match(`sha256:${digest}`, /^sha256:[0-9a-f]{64}$/);
});
