import { randomUUID } from "node:crypto";
import { RuntimeError } from "./errors.mjs";

export const ANNOTATION_SCHEMA_VERSION = 1;
export const BRIDGE_PROTOCOL = "shppt-bridge";
export const BRIDGE_VERSION = 1;
export const CAPTURE_CLICK = "od:bridge:capture-click";
export const CAPTURE_BOX = "od:bridge:capture-box";
export const CAPTURE_TYPES = new Set([CAPTURE_CLICK, CAPTURE_BOX]);

export const ANNOTATION_LIMITS = Object.freeze({
  messageBytes: 128 * 1024,
  text: 1000,
  contextText: 240,
  ancestors: 8,
  boxMembers: 64,
  memberContexts: 64,
  messageId: 128,
  points: 256
});

const TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/i;

export function createAnnotationId() {
  return randomUUID();
}

export function validateBridgeCapture(message, options = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new RuntimeError("BRIDGE_MESSAGE_INVALID", "Bridge capture message must be an object.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new RuntimeError("BRIDGE_MESSAGE_INVALID", "Bridge capture message could not be serialized.");
  }
  if (Buffer.byteLength(serialized, "utf8") > ANNOTATION_LIMITS.messageBytes) {
    throw new RuntimeError("ANNOTATION_PAYLOAD_TOO_LARGE", "Bridge capture message exceeded the supported size.");
  }
  if (message.protocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_VERSION) {
    throw new RuntimeError("BRIDGE_PROTOCOL_UNSUPPORTED", "Bridge capture protocol version is not supported.");
  }
  if (!CAPTURE_TYPES.has(message.type)) {
    throw new RuntimeError("BRIDGE_MESSAGE_TYPE_INVALID", "Bridge message is not a capture event.");
  }
  if (message.source !== "preview" || message.transport !== "MessagePort") {
    throw new RuntimeError("BRIDGE_SOURCE_INVALID", "Bridge capture must come from the preview MessagePort.");
  }
  for (const field of ["nonce", "projectId", "fileIndexVersion", "previewSessionId", "iframeInstanceId", "slideId"]) {
    if (typeof message[field] !== "string" || message[field].length === 0 || message[field].length > 256) {
      throw new RuntimeError("BRIDGE_MESSAGE_INVALID", `Bridge capture field ${field} is invalid.`);
    }
  }
  if (typeof message.origin !== "string" || message.origin.length === 0 || message.origin.length > 256) {
    throw new RuntimeError("BRIDGE_ORIGIN_INVALID", "Bridge capture origin is invalid.");
  }
  if (typeof message.messageId !== "string" || message.messageId.length === 0 || message.messageId.length > ANNOTATION_LIMITS.messageId) {
    throw new RuntimeError("BRIDGE_MESSAGE_INVALID", "Bridge capture messageId is invalid.");
  }
  if (!Number.isInteger(message.sequence) || message.sequence < 1) {
    throw new RuntimeError("BRIDGE_SEQUENCE_INVALID", "Bridge capture sequence must be a positive integer.");
  }
  if (options.projectId && message.projectId !== options.projectId) {
    throw new RuntimeError("PROJECT_ID_MISMATCH", "Bridge capture Project identity did not match the active Project.");
  }
  if (options.fileIndexVersion && message.fileIndexVersion !== options.fileIndexVersion) {
    throw new RuntimeError("PROJECT_VERSION_MISMATCH", "Bridge capture used an outdated File Index snapshot.");
  }
  if (options.slideId && message.slideId !== options.slideId) {
    throw new RuntimeError("DECK_SLIDE_INVALID", "Bridge capture Slide did not match the active preview.");
  }
  if (options.origin && message.origin !== options.origin) {
    throw new RuntimeError("BRIDGE_ORIGIN_INVALID", "Bridge capture origin did not match the daemon origin.");
  }
  if (options.nonce && message.nonce !== options.nonce) {
    throw new RuntimeError("BRIDGE_SESSION_INVALID", "Bridge capture nonce did not match the active session.");
  }
  if (options.lastSequence !== undefined && message.sequence <= options.lastSequence) {
    throw new RuntimeError("BRIDGE_SEQUENCE_OUT_OF_ORDER", "Bridge capture sequence was duplicated or out of order.", { sequence: message.sequence, lastSequence: options.lastSequence });
  }

  const stableElementIds = normalizeStableElementIds(message, options);
  const geometry = normalizeRect(message.geometry, "geometry");
  const domContext = normalizeDomContext(message.domContext, message.type, stableElementIds);
  const intent = normalizeText(message.intent, ANNOTATION_LIMITS.text, "intent", false);
  return {
    schemaVersion: BRIDGE_VERSION,
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    type: message.type,
    source: message.source,
    transport: message.transport,
    origin: message.origin,
    nonce: message.nonce,
    projectId: message.projectId,
    fileIndexVersion: message.fileIndexVersion,
    previewSessionId: message.previewSessionId,
    iframeInstanceId: message.iframeInstanceId,
    slideId: message.slideId,
    sequence: message.sequence,
    messageId: message.messageId,
    geometry,
    stableElementIds,
    domContext,
    intent
  };
}

export function createAnnotationV1({ capture, slide, sourcePath, contentHash, screenshot, evidenceManifestId = null, renderingIdentity = null }) {
  if (!capture || !slide || typeof sourcePath !== "string" || !HASH.test(contentHash || "")) {
    throw new RuntimeError("ANNOTATION_INVALID", "Annotation capture references are incomplete.");
  }
  if (!screenshot || screenshot.overlay !== true || screenshot.mediaType !== "image/png" || !HASH.test(screenshot.sha256 || "")) {
    throw new RuntimeError("ANNOTATION_EVIDENCE_INVALID", "Annotation requires a complete overlay PNG evidence reference.");
  }
  const type = capture.type === CAPTURE_CLICK ? "click" : "box";
  const target = type === "click"
    ? { stableElementId: capture.stableElementIds[0] }
    : { stableElementIds: [...capture.stableElementIds] };
  const now = new Date().toISOString();
  const annotation = {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    annotationId: createAnnotationId(),
    type,
    workflowState: "open",
    anchorState: "anchored",
    projectId: capture.projectId,
    slideId: capture.slideId,
    slideIndex: Number.isInteger(slide.slideIndex) ? slide.slideIndex : null,
    sourcePath,
    contentHash,
    fileIndexVersion: capture.fileIndexVersion,
    versionReference: { sourcePath, contentHash, fileIndexVersion: capture.fileIndexVersion },
    artifactVersionId: null,
    target,
    geometry: capture.geometry,
    domContext: capture.domContext,
    intent: capture.intent,
    capture: {
      previewSessionId: capture.previewSessionId,
      iframeInstanceId: capture.iframeInstanceId,
      messageId: capture.messageId,
      sequence: capture.sequence,
      protocol: capture.protocol,
      version: capture.version,
      transport: capture.transport
    },
    evidence: {
      screenshot,
      evidenceManifestId,
      renderingIdentity
    },
    createdAt: now,
    updatedAt: now
  };
  validateAnnotationV1(annotation);
  return annotation;
}

export function validateAnnotationV1(annotation) {
  if (!annotation || typeof annotation !== "object" || annotation.schemaVersion !== ANNOTATION_SCHEMA_VERSION) {
    throw new RuntimeError("ANNOTATION_SCHEMA_UNSUPPORTED", "Annotation schema version is not supported.");
  }
  if (typeof annotation.annotationId !== "string" || annotation.annotationId.length === 0) throw new RuntimeError("ANNOTATION_INVALID", "Annotation ID is required.");
  if (!["click", "box"].includes(annotation.type)) throw new RuntimeError("ANNOTATION_INVALID", "Annotation type is invalid.");
  if (!["open", "applying", "needs_review", "resolved", "failed"].includes(annotation.workflowState)) throw new RuntimeError("ANNOTATION_INVALID", "Annotation workflow state is invalid.");
  if (!["anchored", "reanchored", "stale", "lost"].includes(annotation.anchorState)) throw new RuntimeError("ANNOTATION_INVALID", "Annotation anchor state is invalid.");
  if (!TOKEN.test(annotation.slideId || "") || typeof annotation.projectId !== "string" || !annotation.projectId) throw new RuntimeError("ANNOTATION_INVALID", "Annotation identity is invalid.");
  if (typeof annotation.sourcePath !== "string" || annotation.sourcePath.length === 0 || annotation.sourcePath.includes("\\") || annotation.sourcePath.startsWith("/") || annotation.sourcePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new RuntimeError("ANNOTATION_INVALID", "Annotation sourcePath is invalid.");
  if (!HASH.test(annotation.contentHash || "") || typeof annotation.fileIndexVersion !== "string" || !HASH.test(annotation.fileIndexVersion)) throw new RuntimeError("ANNOTATION_INVALID", "Annotation version references are invalid.");
  if (!annotation.versionReference || annotation.versionReference.sourcePath !== annotation.sourcePath || annotation.versionReference.contentHash !== annotation.contentHash || annotation.versionReference.fileIndexVersion !== annotation.fileIndexVersion) throw new RuntimeError("ANNOTATION_INVALID", "Annotation versionReference is incomplete.");
  normalizeRect(annotation.geometry, "geometry");
  const ids = annotation.type === "click" ? [annotation.target?.stableElementId] : annotation.target?.stableElementIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ANNOTATION_LIMITS.boxMembers || ids.some((id) => !TOKEN.test(id))) throw new RuntimeError("ANNOTATION_INVALID", "Annotation Stable Element targets are invalid.");
  if (annotation.type === "click" && ids.length !== 1) throw new RuntimeError("ANNOTATION_INVALID", "Click Annotation must contain exactly one Stable Element ID.");
  if (annotation.type === "box" && new Set(ids).size !== ids.length) throw new RuntimeError("ANNOTATION_INVALID", "Box Annotation members must be unique.");
  if (!annotation.evidence?.screenshot || annotation.evidence.screenshot.overlay !== true || annotation.evidence.screenshot.mediaType !== "image/png" || !HASH.test(annotation.evidence.screenshot.sha256 || "") || !Number.isInteger(annotation.evidence.screenshot.byteLength) || annotation.evidence.screenshot.byteLength <= 0 || !Number.isInteger(annotation.evidence.screenshot.width) || !Number.isInteger(annotation.evidence.screenshot.height) || annotation.evidence.screenshot.width <= 0 || annotation.evidence.screenshot.height <= 0) throw new RuntimeError("ANNOTATION_EVIDENCE_INVALID", "Annotation evidence is incomplete.");
  normalizeDomContext(annotation.domContext, annotation.type === "click" ? CAPTURE_CLICK : CAPTURE_BOX, ids);
  return annotation;
}

export function publicAnnotation(annotation) {
  validateAnnotationV1(annotation);
  return JSON.parse(JSON.stringify(annotation));
}

function normalizeStableElementIds(message, options) {
  const ids = message.type === CAPTURE_CLICK ? [message.stableElementId] : message.stableElementIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ANNOTATION_LIMITS.boxMembers || ids.some((id) => !TOKEN.test(id))) {
    throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Bridge capture Stable Element targets are invalid.");
  }
  if (message.type === CAPTURE_CLICK && ids.length !== 1) throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Click capture must identify exactly one Stable Element ID.");
  if (new Set(ids).size !== ids.length) throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Bridge capture Stable Element targets must be unique.");
  if (options.knownStableElementIds) {
    for (const id of ids) if (!options.knownStableElementIds.has(id)) throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Bridge capture identified an unknown Stable Element ID.");
  }
  if (message.type === CAPTURE_BOX && Array.isArray(options.elementOrder)) {
    const indexes = ids.map((id) => options.elementOrder.indexOf(id));
    if (indexes.some((index) => index < 0) || indexes.some((index, i) => i > 0 && index < indexes[i - 1])) throw new RuntimeError("DECK_ELEMENT_ORDER_INVALID", "Box members must be in DOM order.");
  }
  return [...ids];
}

export function normalizeRect(rect, fieldName = "rect") {
  if (!rect || typeof rect !== "object" || !["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key]))) {
    throw new RuntimeError("ANNOTATION_GEOMETRY_INVALID", `${fieldName} must contain finite geometry.`);
  }
  const normalized = { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) };
  if (normalized.x < 0 || normalized.y < 0 || normalized.width <= 0 || normalized.height <= 0 || normalized.x > 1 || normalized.y > 1 || normalized.x + normalized.width > 1.000001 || normalized.y + normalized.height > 1.000001) {
    throw new RuntimeError("ANNOTATION_GEOMETRY_INVALID", `${fieldName} must fit inside the Slide root.`);
  }
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, Math.round(value * 1000000) / 1000000]));
}

function normalizeDomContext(context, type, ids) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", "Bounded DOM context is required.");
  const values = type === CAPTURE_CLICK ? (context.target ? [context.target] : context.members) : context.members;
  if (!Array.isArray(values) || values.length !== ids.length || values.length > ANNOTATION_LIMITS.memberContexts) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", "DOM context does not match the selected targets.");
  const members = values.map((value, index) => normalizeContextEntry(value, ids[index]));
  const ancestors = Array.isArray(context.ancestors) ? context.ancestors.slice(0, ANNOTATION_LIMITS.ancestors).map((value) => normalizeContextEntry(value, null)) : [];
  return { members, ancestors };
}

function normalizeContextEntry(value, expectedId) {
  if (!value || typeof value !== "object") throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", "DOM context entry is invalid.");
  const stableElementId = value.stableElementId ?? null;
  if (stableElementId !== null && !TOKEN.test(stableElementId)) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", "DOM context Stable Element ID is invalid.");
  if (expectedId && stableElementId !== expectedId) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", "DOM context did not match the selected Stable Element ID.");
  return {
    stableElementId,
    tagName: normalizeText(value.tagName, 32, "tagName", true).toLowerCase(),
    role: normalizeText(value.role, 64, "role", false),
    text: normalizeText(value.text, ANNOTATION_LIMITS.contextText, "text", false),
    rect: value.rect ? normalizeRect(value.rect, "context.rect") : null,
    ancestors: Array.isArray(value.ancestors) ? value.ancestors.slice(0, ANNOTATION_LIMITS.ancestors).map((item) => ({
      stableElementId: item?.stableElementId && TOKEN.test(item.stableElementId) ? item.stableElementId : null,
      tagName: normalizeText(item?.tagName, 32, "ancestor.tagName", false).toLowerCase(),
      text: normalizeText(item?.text, ANNOTATION_LIMITS.contextText, "ancestor.text", false)
    })) : []
  };
}

function normalizeText(value, limit, fieldName, required) {
  if (value === undefined || value === null) {
    if (required) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", `${fieldName} is required.`);
    return "";
  }
  if (typeof value !== "string" || value.length > limit) throw new RuntimeError("ANNOTATION_CONTEXT_INVALID", `${fieldName} exceeds its bound.`);
  return value;
}
