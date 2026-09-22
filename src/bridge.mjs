import { CAPTURE_BOX, CAPTURE_CLICK } from "./annotation.mjs";

export const BRIDGE_PROTOCOL = "shppt-bridge";
export const BRIDGE_VERSION = 1;

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function createBridgeScript(config) {
  const serialized = safeJson({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    nonce: config.bridgeNonce,
    projectId: config.projectId,
    fileIndexVersion: config.fileIndexVersion,
    previewSessionId: config.previewSessionId,
    iframeInstanceId: config.iframeInstanceId,
    slideId: config.slideId,
    expectedSlideIds: config.expectedSlideIds || [],
    fontFamily: config.fontFamily || null,
    origin: config.origin
  });
  return `<script data-shppt-bridge="v1">
(function () {
  "use strict";
  const config = ${serialized};
  const HELLO = "od:bridge:hello";
  const HELLO_ACK = "od:bridge:hello-ack";
  const READY = "od:bridge:ready";
  const REQUEST = "od:bridge:request-observation";
  const OBSERVATION = "od:bridge:observation";
  const ACTIVATE = "od:bridge:activate-slide";
  const SET_CAPTURE_MODE = "od:bridge:set-capture-mode";
  const CAPTURE_ACK = "od:bridge:capture-ack";
  const CAPTURE_ERROR = "od:bridge:capture-error";
  let port = null;
  let activeSlideId = config.slideId;
  let sequence = 0;
  let slideFacts = [];
  let captureMode = null;
  let drag = null;

  function token(value) {
    return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
  }

  function slideRoots() {
    return Array.from(document.querySelectorAll("[data-od-slide]"));
  }

  function rectOf(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function captureSlideFacts() {
    const roots = slideRoots();
    const initial = roots.find(function (element) { return element.getAttribute("data-od-slide") === activeSlideId; }) || roots[0] || null;
    if (initial) activeSlideId = initial.getAttribute("data-od-slide");
    slideFacts = roots.map(function (element, index) {
      setActiveElement(element, roots);
      const rect = rectOf(element);
      return {
        slideId: element.getAttribute("data-od-slide"),
        slideIndex: index,
        label: element.getAttribute("data-screen-label") || "Slide " + (index + 1),
        rect: rect
      };
    });
    if (initial) setActiveElement(initial, roots);
  }

  function setActiveElement(selected, roots) {
    roots.forEach(function (element) {
      const isActive = element === selected;
      element.hidden = !isActive;
      element.setAttribute("aria-hidden", isActive ? "false" : "true");
      element.style.display = isActive ? "" : "none";
    });
  }

  function activate(slideId) {
    const roots = slideRoots();
    const selected = roots.find(function (element) { return element.getAttribute("data-od-slide") === slideId; });
    if (!selected) return false;
    activeSlideId = slideId;
    setActiveElement(selected, roots);
    return true;
  }

  function normalizedElement(element, slideRect) {
    const rect = element.getBoundingClientRect();
    return {
      stableElementId: element.getAttribute("data-od-id"),
      rect: {
        x: slideRect.width ? (rect.left - slideRect.x) / slideRect.width : 0,
        y: slideRect.height ? (rect.top - slideRect.y) / slideRect.height : 0,
        width: slideRect.width ? rect.width / slideRect.width : 0,
        height: slideRect.height ? rect.height / slideRect.height : 0
      }
    };
  }

  function observation() {
    const active = slideRoots().find(function (element) { return element.getAttribute("data-od-slide") === activeSlideId; });
    const activeRect = active ? rectOf(active) : { x: 0, y: 0, width: 0, height: 0 };
    const elements = active ? Array.from(active.querySelectorAll("[data-od-id]")) : [];
    sequence += 1;
    return {
      protocol: config.protocol,
      version: config.version,
      type: OBSERVATION,
      source: "preview",
      transport: "MessagePort",
      nonce: config.nonce,
      projectId: config.projectId,
      fileIndexVersion: config.fileIndexVersion,
      previewSessionId: config.previewSessionId,
      iframeInstanceId: config.iframeInstanceId,
      sequence: sequence,
      messageId: config.iframeInstanceId + ":" + sequence,
      activeSlideId: activeSlideId,
      slides: slideFacts.map(function (item) { return item; }),
      activeSlideRect: activeRect,
      elements: elements.map(function (element) { return normalizedElement(element, activeRect); }),
      fonts: Array.from(document.fonts || []).map(function (font) {
        return { family: font.family, status: font.status, weight: font.weight, style: font.style };
      }),
      fontReady: !document.fonts || document.fonts.status === "loaded",
      fontCheck: !config.fontFamily || !document.fonts || document.fonts.check("16px " + JSON.stringify(config.fontFamily)),
      images: Array.from(document.images || []).map(function (image) {
        return { src: image.currentSrc ? "local" : "missing", complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
      }),
      documentReadyState: document.readyState
    };
  }

  function send(message) {
    if (port) port.postMessage(message);
  }

  function onPortMessage(event) {
    const message = event.data || {};
    if (message.protocol !== config.protocol || message.version !== config.version || message.nonce !== config.nonce || message.source !== "host") return;
    if (message.type === REQUEST) send(observation());
    if (message.type === ACTIVATE && token(message.slideId) && activate(message.slideId)) send(observation());
    if (message.type === SET_CAPTURE_MODE) {
      if (message.mode !== null && message.mode !== "click" && message.mode !== "box") {
        send({ protocol: config.protocol, version: config.version, type: CAPTURE_ERROR, source: "preview", transport: "MessagePort", nonce: config.nonce, code: "BRIDGE_CAPTURE_MODE_INVALID", message: "Capture mode is invalid." });
      } else {
        captureMode = message.mode;
        drag = null;
        send({ protocol: config.protocol, version: config.version, type: CAPTURE_ACK, source: "preview", transport: "MessagePort", nonce: config.nonce, status: "mode", mode: captureMode });
      }
    }
  }

  function boundedText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalizedRect(rect, slideRect) {
    const x = slideRect.width ? Math.max(0, Math.min(1, (rect.left - slideRect.left) / slideRect.width)) : 0;
    const y = slideRect.height ? Math.max(0, Math.min(1, (rect.top - slideRect.top) / slideRect.height)) : 0;
    return {
      x: x,
      y: y,
      width: slideRect.width ? Math.min(1 - x, Math.max(0, rect.width / slideRect.width)) : 0,
      height: slideRect.height ? Math.min(1 - y, Math.max(0, rect.height / slideRect.height)) : 0
    };
  }

  function contextFor(element, slideRect) {
    const ancestors = [];
    let current = element.parentElement;
    while (current && current !== document.body && ancestors.length < 8) {
      ancestors.push({
        stableElementId: current.getAttribute("data-od-id") || null,
        tagName: current.tagName.toLowerCase(),
        text: boundedText(current.textContent, 240)
      });
      if (current === document.querySelector('[data-od-slide="' + CSS.escape(activeSlideId) + '"]')) break;
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    return {
      stableElementId: element.getAttribute("data-od-id"),
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      text: boundedText(element.textContent, 240),
      rect: normalizedRect(rect, slideRect),
      ancestors: ancestors
    };
  }

  function activeRoot() {
    return slideRoots().find(function (element) { return element.getAttribute("data-od-slide") === activeSlideId; }) || null;
  }

  function sendCapture(type, geometry, stableElementIds, domContext) {
    if (!port || !captureMode) return;
    sequence += 1;
    send({
      protocol: config.protocol,
      version: config.version,
      type: type,
      source: "preview",
      transport: "MessagePort",
      origin: config.origin,
      nonce: config.nonce,
      projectId: config.projectId,
      fileIndexVersion: config.fileIndexVersion,
      previewSessionId: config.previewSessionId,
      iframeInstanceId: config.iframeInstanceId,
      slideId: activeSlideId,
      sequence: sequence,
      messageId: config.iframeInstanceId + ":capture:" + sequence,
      geometry: geometry,
      stableElementId: type === CAPTURE_CLICK ? stableElementIds[0] : undefined,
      stableElementIds: type === CAPTURE_BOX ? stableElementIds : undefined,
      domContext: domContext
    });
    captureMode = null;
  }

  function pointInRect(x, y, rect) {
    return x >= rect.left && y >= rect.top && x <= rect.right && y <= rect.bottom;
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  document.addEventListener("click", function (event) {
    if (captureMode !== "click") return;
    const root = activeRoot();
    const slideRect = root && root.getBoundingClientRect();
    const target = event.target && event.target.closest ? event.target.closest("[data-od-id]") : null;
    if (!root || !slideRect || !target || !root.contains(target)) {
      if (port) port.postMessage({ protocol: config.protocol, version: config.version, type: CAPTURE_ERROR, source: "preview", transport: "MessagePort", nonce: config.nonce, code: "BRIDGE_CAPTURE_TARGET_MISSING", message: "Click did not identify a Stable Element ID." });
      return;
    }
    event.preventDefault();
    const geometry = normalizedRect(target.getBoundingClientRect(), slideRect);
    const context = contextFor(target, slideRect);
    sendCapture(CAPTURE_CLICK, geometry, [target.getAttribute("data-od-id")], { target: context, ancestors: context.ancestors });
  }, true);

  document.addEventListener("pointerdown", function (event) {
    if (captureMode !== "box") return;
    const root = activeRoot();
    const rect = root && root.getBoundingClientRect();
    if (!root || !rect || !pointInRect(event.clientX, event.clientY, rect)) return;
    drag = { startX: event.clientX, startY: event.clientY, root: root };
    event.preventDefault();
  }, true);

  document.addEventListener("pointerup", function (event) {
    if (!drag || captureMode !== "box") return;
    const root = drag.root;
    const slideRect = root.getBoundingClientRect();
    const selection = {
      left: Math.max(slideRect.left, Math.min(drag.startX, event.clientX)),
      top: Math.max(slideRect.top, Math.min(drag.startY, event.clientY)),
      right: Math.min(slideRect.right, Math.max(drag.startX, event.clientX)),
      bottom: Math.min(slideRect.bottom, Math.max(drag.startY, event.clientY))
    };
    drag = null;
    event.preventDefault();
    const members = Array.from(root.querySelectorAll("[data-od-id]")).filter(function (element) { return intersects(element.getBoundingClientRect(), selection); });
    if (!members.length) {
      if (port) port.postMessage({ protocol: config.protocol, version: config.version, type: CAPTURE_ERROR, source: "preview", transport: "MessagePort", nonce: config.nonce, code: "BRIDGE_CAPTURE_EMPTY", message: "Box did not contain a Stable Element ID." });
      return;
    }
    const geometry = normalizedRect({ left: selection.left, top: selection.top, width: selection.right - selection.left, height: selection.bottom - selection.top }, slideRect);
    const contexts = members.map(function (element) { return contextFor(element, slideRect); });
    sendCapture(CAPTURE_BOX, geometry, members.map(function (element) { return element.getAttribute("data-od-id"); }), { members: contexts, ancestors: contexts[0].ancestors });
  }, true);

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== config.origin) return;
    const message = event.data || {};
    if (message.protocol !== config.protocol || message.version !== config.version || message.type !== HELLO_ACK || message.nonce !== config.nonce || !event.ports || !event.ports[0]) return;
    port = event.ports[0];
    port.addEventListener("message", onPortMessage);
    port.start();
    send({
      protocol: config.protocol,
      version: config.version,
      type: READY,
      nonce: config.nonce,
      projectId: config.projectId,
      fileIndexVersion: config.fileIndexVersion,
      previewSessionId: config.previewSessionId,
      iframeInstanceId: config.iframeInstanceId,
      transport: "MessagePort"
    });
  });

  function start() {
    captureSlideFacts();
    activate(activeSlideId);
    window.parent.postMessage({
      protocol: config.protocol,
      version: config.version,
      type: HELLO,
      nonce: config.nonce,
      projectId: config.projectId,
      fileIndexVersion: config.fileIndexVersion,
      previewSessionId: config.previewSessionId,
      iframeInstanceId: config.iframeInstanceId,
       source: "preview"
    }, config.origin);
  }

  Promise.resolve(document.fonts && document.fonts.ready).then(start, start);
})();
</script>`;
}

export function injectBridge(html, config) {
  const script = createBridgeScript(config);
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose < 0) return `${html}\n${script}`;
  return `${html.slice(0, bodyClose)}${script}${html.slice(bodyClose)}`;
}

export function createRendererHtml(config) {
  const serialized = safeJson({
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    projectId: config.projectId,
    fileIndexVersion: config.fileIndexVersion,
    previewSessionId: config.previewSessionId,
    iframeInstanceId: config.iframeInstanceId,
    scopeId: config.scopeId,
    bridgeNonce: config.bridgeNonce,
    slideId: config.slideId,
    expectedSlideIds: config.expectedSlideIds || [],
    entryUrl: config.entryUrl,
    annotationApi: config.annotationApi || (config.origin + "/api/annotations"),
    overlay: config.overlay || null,
    capture: Boolean(config.capture),
    origin: config.origin
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SHppt Preview</title>
  <style>
    :root { color-scheme: dark; font-family: Segoe UI, sans-serif; background: #131920; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #131920; }
    #preview-frame { position: fixed; inset: 2rem 0 0; width: 100%; height: calc(100% - 2rem); border: 0; background: #fff; }
    #preview-status { position: fixed; z-index: 2; inset: 0 0 auto; height: 2rem; display: flex; align-items: center; gap: 1rem; padding: 0 .75rem; color: #e5edf3; background: #1e2933; font: 12px/1 Segoe UI, sans-serif; }
    #preview-status[data-state="ready"] { color: #a5e3cf; }
    #preview-status[data-state="error"] { color: #ffadad; }
    #slide-list { display: flex; gap: .35rem; margin-left: auto; }
    #slide-list button { border: 1px solid #587181; border-radius: 3px; padding: .25rem .5rem; color: inherit; background: transparent; cursor: pointer; }
    #annotation-controls { display: flex; gap: .35rem; align-items: center; }
    #annotation-controls button { border: 1px solid #587181; border-radius: 3px; padding: .25rem .5rem; color: inherit; background: transparent; cursor: pointer; }
    #annotation-controls button[data-active="true"] { border-color: #a5e3cf; color: #a5e3cf; }
    #annotation-list { position: fixed; z-index: 3; left: .75rem; bottom: .75rem; max-width: 22rem; max-height: 12rem; overflow: auto; color: #d6e3ea; background: rgba(30, 41, 51, .94); font: 12px/1.35 Segoe UI, sans-serif; }
    .annotation-item { display: grid; grid-template-columns: 1fr auto; gap: .35rem; padding: .45rem .6rem; border-bottom: 1px solid #405462; }
    .annotation-item img { width: 4rem; height: 2.25rem; object-fit: cover; border: 1px solid #587181; }
    #capture-overlay { position: fixed; z-index: 4; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    body[data-capture="true"] #preview-status { display: none; }
    body[data-capture="true"] #annotation-list { display: none; }
    body[data-capture="true"] #preview-frame { inset: 0; width: 100%; height: 100%; }
  </style>
</head>
<body data-capture="${config.capture ? "true" : "false"}">
  <div id="preview-status" data-state="loading"><span id="preview-state">loading</span><span id="annotation-controls"><button id="annotation-click" type="button">click</button><button id="annotation-box" type="button">box</button><span id="annotation-state">capture unavailable</span></span><span id="slide-list"></span></div>
  <div id="annotation-list" aria-live="polite"></div>
  <iframe id="preview-frame" title="SHppt Slide preview" src="${config.entryUrl}"></iframe>
  ${config.overlay ? `<svg id="capture-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><rect x="${Number(config.overlay.geometry?.x || 0)}" y="${Number(config.overlay.geometry?.y || 0)}" width="${Number(config.overlay.geometry?.width || 0)}" height="${Number(config.overlay.geometry?.height || 0)}" fill="rgba(255,214,92,.16)" stroke="#ffb703" stroke-width=".006"/><g>${(config.overlay.memberRects || []).map((rect) => `<rect x="${Number(rect.x || 0)}" y="${Number(rect.y || 0)}" width="${Number(rect.width || 0)}" height="${Number(rect.height || 0)}" fill="none" stroke="#fb8500" stroke-width=".003"/>`).join("")}</g></svg>` : ""}
  <script>
  (function () {
    "use strict";
    const config = ${serialized};
    const HELLO = "od:bridge:hello";
    const HELLO_ACK = "od:bridge:hello-ack";
    const READY = "od:bridge:ready";
    const OBSERVATION = "od:bridge:observation";
    const REQUEST = "od:bridge:request-observation";
    const ACTIVATE = "od:bridge:activate-slide";
    const SET_CAPTURE_MODE = "od:bridge:set-capture-mode";
    const CAPTURE_CLICK = "od:bridge:capture-click";
    const CAPTURE_BOX = "od:bridge:capture-box";
    const CAPTURE_ACK = "od:bridge:capture-ack";
    const CAPTURE_ERROR = "od:bridge:capture-error";
    const frame = document.getElementById("preview-frame");
    const status = document.getElementById("preview-status");
    const statusText = document.getElementById("preview-state");
    const slideList = document.getElementById("slide-list");
    const annotationState = document.getElementById("annotation-state");
    const annotationList = document.getElementById("annotation-list");
    const state = { status: "loading", handshake: "pending", error: null, observation: null, transport: null, sequence: 0, port: null, captureIds: {}, annotations: [] };
    window.__shpptRendererState = state;

    function setState(next, error) {
      state.status = next;
      state.error = error || null;
      status.dataset.state = next;
      statusText.textContent = error ? next + ": " + error.code : next;
    }

    function validRect(rect) {
      return rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 1 && rect.height > 1;
    }

    function validObservation(observation) {
      if (!observation || observation.protocol !== config.protocol || observation.version !== config.version || observation.type !== OBSERVATION || observation.source !== "preview" || observation.transport !== "MessagePort" || !Number.isInteger(observation.sequence) || observation.sequence < 1 || observation.nonce !== config.bridgeNonce || observation.projectId !== config.projectId || observation.fileIndexVersion !== config.fileIndexVersion || observation.previewSessionId !== config.previewSessionId || observation.iframeInstanceId !== config.iframeInstanceId) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Bridge observation identity did not match the active preview." };
      if (!Array.isArray(observation.slides) || observation.slides.length === 0 || !validRect(observation.activeSlideRect)) return { code: "DECK_SLIDE_INVALID", message: "Bridge observation did not contain a non-empty Slide." };
      const observedSlideIds = observation.slides.map(function (slide) { return slide.slideId; });
      const expectedSlideIds = Array.isArray(config.expectedSlideIds) ? config.expectedSlideIds : [];
      if (expectedSlideIds.length && (observedSlideIds.length !== expectedSlideIds.length || expectedSlideIds.some(function (slideId) { return !observedSlideIds.includes(slideId); }) || new Set(observedSlideIds).size !== observedSlideIds.length)) return { code: "DECK_SLIDE_INVALID", message: "Bridge observation did not match the indexed Slide IDs." };
      const ratios = observation.slides.map(function (slide) { return validRect(slide.rect) ? slide.rect.width / slide.rect.height : 0; });
      if (ratios.some(function (ratio) { return ratio <= 0; }) || ratios.some(function (ratio) { return Math.abs(ratio - ratios[0]) > 0.01; })) return { code: "DECK_SLIDE_SIZE_MISMATCH", message: "Slide aspect ratios do not match.", details: { ratios: ratios, rects: observation.slides.map(function (slide) { return slide.rect; }) } };
      if (!observation.activeSlideId || !observation.slides.some(function (slide) { return slide.slideId === observation.activeSlideId; })) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Active Slide was not present in the observation." };
      if (!Array.isArray(observation.elements) || observation.elements.length > 256) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Bridge element observation exceeded the supported bound." };
      return null;
    }

    function validCapture(message) {
      if (!message || (message.type !== CAPTURE_CLICK && message.type !== CAPTURE_BOX) || message.protocol !== config.protocol || message.version !== config.version || message.source !== "preview" || message.transport !== "MessagePort" || message.origin !== config.origin || message.nonce !== config.bridgeNonce || message.projectId !== config.projectId || message.fileIndexVersion !== config.fileIndexVersion || message.previewSessionId !== config.previewSessionId || message.iframeInstanceId !== config.iframeInstanceId || message.slideId !== state.observation?.activeSlideId || !Number.isInteger(message.sequence) || message.sequence < 1 || typeof message.messageId !== "string") return { code: "BRIDGE_CAPTURE_INVALID", message: "Bridge capture identity did not match the active preview." };
      if (state.captureIds[message.messageId]) return { duplicate: true };
      if (message.sequence <= state.sequence) return { code: "BRIDGE_SEQUENCE_OUT_OF_ORDER", message: "Bridge capture sequence was duplicated or out of order." };
      if (message.type === CAPTURE_CLICK && typeof message.stableElementId !== "string") return { code: "DECK_ELEMENT_ID_INVALID", message: "Click capture did not identify a Stable Element ID." };
      if (message.type === CAPTURE_BOX && (!Array.isArray(message.stableElementIds) || message.stableElementIds.length === 0)) return { code: "DECK_ELEMENT_ID_INVALID", message: "Box capture did not identify Stable Element IDs." };
      return null;
    }

    function sendCaptureAck(message, result) {
      if (!state.port) return;
      state.port.postMessage({ protocol: config.protocol, version: config.version, type: CAPTURE_ACK, source: "host", transport: "MessagePort", nonce: config.bridgeNonce, projectId: config.projectId, fileIndexVersion: config.fileIndexVersion, previewSessionId: config.previewSessionId, iframeInstanceId: config.iframeInstanceId, messageId: message?.messageId || null, sequence: message?.sequence || null, status: result.status, annotationId: result.annotationId || null, error: result.error || null });
    }

    function renderAnnotations() {
      annotationList.textContent = "";
      state.annotations.slice(0, 16).forEach(function (annotation) {
        const item = document.createElement("div");
        item.className = "annotation-item";
        const text = document.createElement("span");
        const target = annotation.type === "click" ? annotation.target.stableElementId : annotation.target.stableElementIds.join(", ");
        text.textContent = annotation.type + " / " + target + " / " + annotation.workflowState;
        item.appendChild(text);
        const assetId = annotation.evidence?.screenshot?.assetId;
        if (assetId) {
          const image = document.createElement("img");
          image.alt = "Annotation evidence";
          image.src = "/api/evidence/" + encodeURIComponent(assetId);
          item.appendChild(image);
        }
        annotationList.appendChild(item);
      });
    }

    async function loadAnnotations() {
      try {
        const response = await fetch(config.annotationApi + "?projectId=" + encodeURIComponent(config.projectId) + "&fileIndexVersion=" + encodeURIComponent(config.fileIndexVersion));
        if (!response.ok) return;
        const body = await response.json();
        state.annotations = Array.isArray(body.annotations) ? body.annotations : [];
        renderAnnotations();
      } catch {}
    }

    async function acceptCapture(message) {
      const validation = validCapture(message);
      if (validation?.duplicate) {
        sendCaptureAck(message, state.captureIds[message.messageId]);
        return;
      }
      if (validation) {
        sendCaptureAck(message, { status: "rejected", error: validation });
        setState("error", validation);
        return;
      }
      state.sequence = message.sequence;
      state.captureIds[message.messageId] = { status: "pending", annotationId: null };
      annotationState.textContent = "saving";
      try {
        const response = await fetch(config.annotationApi, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: config.projectId, fileIndexVersion: config.fileIndexVersion, capture: message }) });
        const body = await response.json();
        const result = body.ack || { status: "rejected", error: body.error || { code: "ANNOTATION_SAVE_FAILED", message: "Annotation could not be saved." } };
        state.captureIds[message.messageId] = result;
        sendCaptureAck(message, result);
        annotationState.textContent = result.status === "accepted" || result.status === "duplicate" ? "saved" : "rejected";
        if (result.status === "accepted") await loadAnnotations();
        if (result.status === "rejected") setState("error", result.error);
      } catch {
        const result = { status: "rejected", error: { code: "ANNOTATION_SAVE_FAILED", message: "Annotation could not be saved." } };
        state.captureIds[message.messageId] = result;
        sendCaptureAck(message, result);
        setState("error", result.error);
      }
    }

    function setCaptureMode(mode) {
      if (!state.port || state.handshake !== "accepted") {
        annotationState.textContent = "bridge unavailable";
        return;
      }
      state.port.postMessage({ protocol: config.protocol, version: config.version, type: SET_CAPTURE_MODE, source: "host", transport: "MessagePort", nonce: config.bridgeNonce, mode: mode });
      document.getElementById("annotation-click").dataset.active = mode === "click" ? "true" : "false";
      document.getElementById("annotation-box").dataset.active = mode === "box" ? "true" : "false";
      annotationState.textContent = mode + " armed";
    }

    function renderSlides() {
      slideList.textContent = "";
      if (!state.observation) return;
      state.observation.slides.forEach(function (slide) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.slideId = slide.slideId;
        button.setAttribute("aria-pressed", slide.slideId === state.observation.activeSlideId ? "true" : "false");
        button.textContent = slide.label;
        button.addEventListener("click", function () {
          if (state.port) state.port.postMessage({ protocol: config.protocol, version: config.version, type: ACTIVATE, source: "host", transport: "MessagePort", nonce: config.bridgeNonce, slideId: slide.slideId });
        });
        slideList.appendChild(button);
      });
    }

    function acceptObservation(observation) {
      if (observation && Number.isInteger(observation.sequence) && observation.sequence <= state.sequence) return;
      const error = validObservation(observation);
      if (error) {
        setState("error", error);
        return;
      }
      state.observation = observation;
      state.sequence = observation.sequence;
      state.status = "ready";
      state.handshake = "accepted";
      state.transport = "MessagePort";
      renderSlides();
      setState("ready");
    }

    window.addEventListener("message", function (event) {
      if (event.source !== frame.contentWindow || event.origin !== config.origin) return;
      const message = event.data || {};
      if (state.handshake !== "pending" || message.protocol !== config.protocol || message.version !== config.version || message.type !== HELLO || message.source !== "preview" || message.nonce !== config.bridgeNonce || message.projectId !== config.projectId || message.fileIndexVersion !== config.fileIndexVersion || message.previewSessionId !== config.previewSessionId || message.iframeInstanceId !== config.iframeInstanceId) {
        if (message.type === HELLO && state.handshake !== "pending") return;
        if (message.type === HELLO && message.nonce !== config.bridgeNonce) setState("error", { code: "BRIDGE_HANDSHAKE_INVALID", message: "Bridge nonce or source did not match." });
        return;
      }
      const channel = new MessageChannel();
      state.handshake = "acknowledged";
      state.port = channel.port1;
      channel.port1.addEventListener("message", function (portEvent) {
        const portMessage = portEvent.data || {};
        if (portMessage.type === CAPTURE_ERROR) {
          if (portMessage.protocol === config.protocol && portMessage.version === config.version && portMessage.nonce === config.bridgeNonce && portMessage.source === "preview") setState("error", portMessage);
          return;
        }
        if (portMessage.protocol !== config.protocol || portMessage.version !== config.version || portMessage.nonce !== config.bridgeNonce || portMessage.projectId !== config.projectId || portMessage.fileIndexVersion !== config.fileIndexVersion || portMessage.previewSessionId !== config.previewSessionId || portMessage.iframeInstanceId !== config.iframeInstanceId) return;
        if (portMessage.type === READY) {
          state.handshake = "accepted";
          state.transport = portMessage.transport;
          annotationState.textContent = "ready";
          state.port.postMessage({ protocol: config.protocol, version: config.version, type: REQUEST, source: "host", transport: "MessagePort", nonce: config.bridgeNonce });
        } else if (portMessage.type === OBSERVATION) {
          acceptObservation(portMessage);
        } else if (portMessage.type === CAPTURE_CLICK || portMessage.type === CAPTURE_BOX) {
          acceptCapture(portMessage);
        }
      });
      channel.port1.start();
      event.source.postMessage({ protocol: config.protocol, version: config.version, type: HELLO_ACK, nonce: config.bridgeNonce, projectId: config.projectId, fileIndexVersion: config.fileIndexVersion, previewSessionId: config.previewSessionId, iframeInstanceId: config.iframeInstanceId }, config.origin, [channel.port2]);
    });

    window.__shpptSetCaptureMode = function (enabled) { document.body.dataset.capture = enabled ? "true" : "false"; };
    window.__shpptSelectSlide = function (slideId) {
      if (state.port) state.port.postMessage({ protocol: config.protocol, version: config.version, type: ACTIVATE, source: "host", transport: "MessagePort", nonce: config.bridgeNonce, slideId: slideId });
    };
    window.__shpptBridgeReady = function () { return state.status === "ready" && state.handshake === "accepted"; };
    document.getElementById("annotation-click").addEventListener("click", function () { setCaptureMode("click"); });
    document.getElementById("annotation-box").addEventListener("click", function () { setCaptureMode("box"); });
    loadAnnotations();
  })();
  </script>
</body>
</html>`;
}
