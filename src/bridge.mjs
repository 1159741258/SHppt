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
  let port = null;
  let activeSlideId = config.slideId;
  let sequence = 0;
  let slideFacts = [];

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
    slideFacts = slideRoots().map(function (element, index) {
      const rect = rectOf(element);
      return {
        slideId: element.getAttribute("data-od-slide"),
        slideIndex: index,
        label: element.getAttribute("data-screen-label") || "Slide " + (index + 1),
        rect: rect
      };
    });
  }

  function activate(slideId) {
    const roots = slideRoots();
    const selected = roots.find(function (element) { return element.getAttribute("data-od-slide") === slideId; });
    if (!selected) return false;
    activeSlideId = slideId;
    roots.forEach(function (element) {
      const isActive = element === selected;
      element.hidden = !isActive;
      element.setAttribute("aria-hidden", isActive ? "false" : "true");
      element.style.display = isActive ? "" : "none";
    });
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
      fontCheck: !document.fonts || document.fonts.check("16px \\\"Fixture Sans\\\""),
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
    if (message.protocol !== config.protocol || message.version !== config.version || message.nonce !== config.nonce) return;
    if (message.type === REQUEST) send(observation());
    if (message.type === ACTIVATE && token(message.slideId) && activate(message.slideId)) send(observation());
  }

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
    if (!activeSlideId && slideFacts[0]) activeSlideId = slideFacts[0].slideId;
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
    entryUrl: config.entryUrl,
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
    body[data-capture="true"] #preview-status { display: none; }
    body[data-capture="true"] #preview-frame { inset: 0; width: 100%; height: 100%; }
  </style>
</head>
<body data-capture="${config.capture ? "true" : "false"}">
  <div id="preview-status" data-state="loading"><span id="preview-state">loading</span><span id="slide-list"></span></div>
  <iframe id="preview-frame" title="SHppt Slide preview" src="${config.entryUrl}"></iframe>
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
    const frame = document.getElementById("preview-frame");
    const status = document.getElementById("preview-status");
    const statusText = document.getElementById("preview-state");
    const slideList = document.getElementById("slide-list");
    const state = { status: "loading", handshake: "pending", error: null, observation: null, transport: null, sequence: 0 };
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
      if (!observation || observation.protocol !== config.protocol || observation.version !== config.version || observation.type !== OBSERVATION || !Number.isInteger(observation.sequence) || observation.sequence < 1 || observation.nonce !== config.bridgeNonce || observation.projectId !== config.projectId || observation.fileIndexVersion !== config.fileIndexVersion || observation.previewSessionId !== config.previewSessionId || observation.iframeInstanceId !== config.iframeInstanceId) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Bridge observation identity did not match the active preview." };
      if (!Array.isArray(observation.slides) || observation.slides.length === 0 || !validRect(observation.activeSlideRect)) return { code: "DECK_SLIDE_INVALID", message: "Bridge observation did not contain a non-empty Slide." };
      const ratios = observation.slides.map(function (slide) { return slide.rect && slide.rect.width > 0 && slide.rect.height > 0 ? slide.rect.width / slide.rect.height : 0; });
      if (ratios.some(function (ratio) { return ratio <= 0; }) || ratios.some(function (ratio) { return Math.abs(ratio - ratios[0]) > 0.01; })) return { code: "DECK_SLIDE_SIZE_MISMATCH", message: "Slide aspect ratios do not match.", details: { ratios: ratios, rects: observation.slides.map(function (slide) { return slide.rect; }) } };
      if (!observation.activeSlideId || !observation.slides.some(function (slide) { return slide.slideId === observation.activeSlideId; })) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Active Slide was not present in the observation." };
      if (!Array.isArray(observation.elements) || observation.elements.length > 256) return { code: "BRIDGE_OBSERVATION_INVALID", message: "Bridge element observation exceeded the supported bound." };
      return null;
    }

    function renderSlides() {
      slideList.textContent = "";
      if (!state.observation) return;
      state.observation.slides.forEach(function (slide) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = slide.label;
        button.addEventListener("click", function () {
          if (state.port) state.port.postMessage({ protocol: config.protocol, version: config.version, type: ACTIVATE, nonce: config.bridgeNonce, slideId: slide.slideId });
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
        if (portMessage.protocol !== config.protocol || portMessage.version !== config.version || portMessage.nonce !== config.bridgeNonce || portMessage.projectId !== config.projectId || portMessage.fileIndexVersion !== config.fileIndexVersion || portMessage.previewSessionId !== config.previewSessionId || portMessage.iframeInstanceId !== config.iframeInstanceId) return;
        if (portMessage.type === READY) {
          state.handshake = "accepted";
          state.transport = portMessage.transport;
          state.port.postMessage({ protocol: config.protocol, version: config.version, type: REQUEST, nonce: config.bridgeNonce });
        } else if (portMessage.type === OBSERVATION) {
          acceptObservation(portMessage);
        }
      });
      channel.port1.start();
      event.source.postMessage({ protocol: config.protocol, version: config.version, type: HELLO_ACK, nonce: config.bridgeNonce, projectId: config.projectId, fileIndexVersion: config.fileIndexVersion, previewSessionId: config.previewSessionId, iframeInstanceId: config.iframeInstanceId }, config.origin, [channel.port2]);
    });

    window.__shpptSetCaptureMode = function (enabled) { document.body.dataset.capture = enabled ? "true" : "false"; };
    window.__shpptSelectSlide = function (slideId) {
      if (state.port) state.port.postMessage({ protocol: config.protocol, version: config.version, type: ACTIVATE, nonce: config.bridgeNonce, slideId: slideId });
    };
    window.__shpptBridgeReady = function () { return state.status === "ready" && state.handshake === "accepted"; };
  })();
  </script>
</body>
</html>`;
}
