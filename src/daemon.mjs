import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { canonicalizeContentRoot, getFile, loadOrCreateProjectId, publicSnapshot, readSnapshotFile, scanProject, validateProjectRelativePath } from "./project.mjs";
import { createRendererHtml, injectBridge } from "./bridge.mjs";
import { CdpRenderer } from "./cdp-renderer.mjs";
import { RuntimeError, publicError } from "./errors.mjs";

const DEFAULT_BUILD_IDENTITY = "dev-local";
const MAX_REQUEST_BYTES = 512 * 1024;
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"]
]);

export class LocalDaemon {
  constructor({ contentRoot, port = 0, stateDirectory = null, evidenceDirectory = null, browserName = "chrome", browserPath = null, buildIdentity = DEFAULT_BUILD_IDENTITY }) {
    this.inputContentRoot = contentRoot;
    this.port = port;
    this.stateDirectory = stateDirectory || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "SHppt");
    this.evidenceDirectory = evidenceDirectory || path.join(this.stateDirectory, "evidence");
    this.browserName = browserName;
    this.browserPath = browserPath;
    this.buildIdentity = buildIdentity;
    this.contentRoot = null;
    this.projectId = null;
    this.snapshot = null;
    this.scanFailure = null;
    this.server = null;
    this.origin = null;
    this.previewScopes = new Map();
    this.previews = new Map();
    this.assets = new Map();
    this.sseClients = new Set();
    this.streamEpoch = randomUUID();
    this.sequence = 0;
  }

  async start() {
    this.contentRoot = await canonicalizeContentRoot(this.inputContentRoot);
    this.projectId = await loadOrCreateProjectId(this.stateDirectory, this.contentRoot);
    await fs.mkdir(this.evidenceDirectory, { recursive: true });
    await this.rescan();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => this.handleError(response, error));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    this.origin = `http://127.0.0.1:${this.port}`;
    return { origin: this.origin, projectId: this.projectId, snapshot: this.snapshot ? publicSnapshot(this.snapshot) : null, scanFailure: this.scanFailure };
  }

  async stop() {
    for (const client of this.sseClients) {
      clearInterval(client.heartbeat);
      client.response.end();
    }
    this.sseClients.clear();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  async rescan() {
    const previousVersion = this.snapshot?.fileIndexVersion || null;
    try {
      this.snapshot = await scanProject({ contentRoot: this.contentRoot || this.inputContentRoot, projectId: this.projectId || randomUUID() });
      this.scanFailure = null;
      if (previousVersion !== this.snapshot.fileIndexVersion) this.previewScopes.clear();
      if (this.origin) this.publish("project.scan-ready", { fileIndexVersion: this.snapshot.fileIndexVersion });
      return this.snapshot;
    } catch (error) {
      this.snapshot = null;
      this.previewScopes.clear();
      this.scanFailure = publicError(error);
      if (this.origin) this.publish("project.scan-failed", { error: this.scanFailure });
      return null;
    }
  }

  async handle(request, response) {
    const requestUrl = new URL(request.url || "/", this.origin || "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    if (pathname === "/health" || pathname === "/api/health") return this.health(response);
    if (pathname === "/api/project" && request.method === "GET") return this.project(response);
    if (pathname === "/api/events" && request.method === "GET") return this.events(request, response);
    if (pathname === "/api/preview" && request.method === "POST") return this.createPreview(request, response);
    if (pathname === "/api/rescan" && request.method === "POST") return this.rescanEndpoint(request, response);
    if (pathname.startsWith("/api/preview/") && request.method === "GET") return this.previewStatus(pathname, response);
    if (pathname.startsWith("/api/evidence/") && request.method === "GET") return this.evidenceAsset(pathname, response);
    if (pathname.startsWith("/renderer/") && request.method === "GET") return this.rendererDocument(pathname, requestUrl, response);
    if (pathname.startsWith("/preview/") && request.method === "GET") return this.previewResource(pathname, requestUrl, response);
    return sendJson(response, 404, { error: { code: "HTTP_NOT_FOUND", message: "Resource not found.", details: {} } });
  }

  health(response) {
    return sendJson(response, this.scanFailure ? 503 : 200, {
      status: this.scanFailure ? "degraded" : "ok",
      buildIdentity: this.buildIdentity,
      project: this.snapshot ? {
        projectId: this.snapshot.projectId,
        type: this.snapshot.type,
        entryPath: this.snapshot.entryPath,
        fileIndexVersion: this.snapshot.fileIndexVersion
      } : { projectId: this.projectId, type: "html-deck", entryPath: null, fileIndexVersion: null },
      renderer: { adapter: "cdp", browser: this.browserName, mode: "headless" },
      scanError: this.scanFailure
    });
  }

  project(response) {
    if (this.scanFailure || !this.snapshot) return sendJson(response, 409, { error: this.scanFailure || { code: "PROJECT_SCAN_FAILED", message: "Project scan has not succeeded.", details: {} } });
    return sendJson(response, 200, {
      project: publicSnapshot(this.snapshot),
      preview: { state: "idle", ready: false, renderer: "cdp" }
    });
  }

  async rescanEndpoint(request, response) {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RuntimeError("HTTP_JSON_INVALID", "Rescan request must be a JSON object.");
    if (body.projectId !== this.projectId) throw new RuntimeError("PROJECT_ID_MISMATCH", "Project identity did not match the daemon.");
    const snapshot = await this.rescan();
    if (!snapshot) return sendJson(response, 409, { error: this.scanFailure });
    return sendJson(response, 200, { project: publicSnapshot(snapshot) });
  }

  async createPreview(request, response) {
    if (this.scanFailure || !this.snapshot) throw new RuntimeError("PROJECT_SCAN_FAILED", "A valid Project snapshot is required before preview.");
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RuntimeError("HTTP_JSON_INVALID", "Preview request must be a JSON object.");
    if (body.projectId !== this.snapshot.projectId) throw new RuntimeError("PROJECT_ID_MISMATCH", "Project identity did not match the active snapshot.");
    if (body.fileIndexVersion !== this.snapshot.fileIndexVersion) throw new RuntimeError("PROJECT_VERSION_MISMATCH", "Preview requested an outdated File Index snapshot.");
    const slideId = body.slideId;
    if (typeof slideId !== "string") throw new RuntimeError("DECK_SLIDE_INVALID", "Preview requires a Slide ID.");
    const slide = this.snapshot.slides.find((candidate) => candidate.slideId === slideId);
    if (!slide) throw new RuntimeError("DECK_SLIDE_INVALID", "Preview requested an unknown Slide ID.");
    const viewport = normalizeViewport(body.viewport);
    const dpr = normalizeDpr(body.dpr);
    const previewSessionId = randomUUID();
    const iframeInstanceId = randomUUID();
    const scopeId = randomUUID();
    const bridgeNonce = randomUUID();
    const scope = {
      scopeId,
      projectId: this.projectId,
      fileIndexVersion: this.snapshot.fileIndexVersion,
      entryPath: this.snapshot.entryPath,
      slideId,
      previewSessionId,
      iframeInstanceId,
      bridgeNonce,
      expiresAt: Date.now() + 5 * 60 * 1000,
      viewport,
      dpr
    };
    this.previewScopes.set(scopeId, scope);
    const rendererUrl = `${this.origin}/renderer/${scopeId}?session=${encodeURIComponent(previewSessionId)}&iframe=${encodeURIComponent(iframeInstanceId)}&nonce=${encodeURIComponent(bridgeNonce)}&slide=${encodeURIComponent(slideId)}&capture=false`;
    const captureRendererUrl = `${this.origin}/renderer/${scopeId}?session=${encodeURIComponent(previewSessionId)}&iframe=${encodeURIComponent(iframeInstanceId)}&nonce=${encodeURIComponent(bridgeNonce)}&slide=${encodeURIComponent(slideId)}&capture=true`;
    const preview = {
      previewSessionId,
      iframeInstanceId,
      projectId: this.projectId,
      fileIndexVersion: this.snapshot.fileIndexVersion,
      slideId,
      rendererUrl,
      status: "loading",
      state: "loading",
      error: null,
      createdAt: new Date().toISOString(),
      renderingIdentity: null,
      screenshot: null,
      observation: null,
      evidenceManifestId: null
    };
    this.previews.set(previewSessionId, preview);
    this.publish("preview.loading", { previewSessionId, iframeInstanceId, slideId, state: "loading", fileIndexVersion: this.snapshot.fileIndexVersion, rendererUrl });
    const screenshotDirectory = path.join(this.evidenceDirectory, this.projectId, previewSessionId);
    try {
      const renderer = new CdpRenderer({ browserName: this.browserName, browserPath: this.browserPath, viewport, dpr, hostOrigin: this.origin });
      const result = await renderer.render({ rendererUrl: captureRendererUrl, slideIds: [slideId], screenshotDirectory });
      const observation = validateObservation(result.observation, this.snapshot, scope);
      const screenshotFile = result.screenshots[slideId];
      if (!screenshotFile) throw new RuntimeError("PREVIEW_SCREENSHOT_FAILED", "The renderer did not return a Slide screenshot.");
      const screenshotBytes = await fs.readFile(screenshotFile.path);
      const png = inspectPng(screenshotBytes, Math.round(viewport.width * dpr), Math.round(viewport.height * dpr));
      if (!png.valid || !png.nonEmpty) throw new RuntimeError("PREVIEW_SCREENSHOT_INVALID", "The renderer returned an invalid or empty PNG screenshot.", { width: png.width, height: png.height });
      const assetId = randomUUID();
      const assetPath = path.join(screenshotDirectory, `${slideId}-${assetId}.png`);
      await fs.writeFile(assetPath, screenshotBytes);
      const fontHash = this.snapshot.files.find((file) => file.kind === "font")?.contentHash || null;
      const renderingIdentity = {
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        node: process.version,
        browser: result.browserVersion?.Browser || `${this.browserName} unknown`,
        browserProtocol: result.browserVersion?.["Protocol-Version"] || null,
        renderingMode: "cdp-headless",
        viewport,
        dpr,
        fontHash,
        fixtureHash: this.snapshot.fixtureHash,
        buildIdentity: this.buildIdentity,
        projectId: this.projectId,
        fileIndexVersion: this.snapshot.fileIndexVersion,
        entryPath: this.snapshot.entryPath,
        slideId
      };
      const screenshot = {
        assetId,
        mediaType: "image/png",
        byteLength: screenshotBytes.length,
        sha256: `sha256:${sha256(screenshotBytes)}`,
        width: png.width,
        height: png.height
      };
      this.assets.set(assetId, { path: assetPath, mediaType: "image/png", screenshot });
      const evidenceManifest = await this.writeEvidence({
        result: "passed",
        preview,
        observation,
        screenshot,
        renderingIdentity,
        assertions: ["bridge-handshake", "dom-observation", "non-empty-slide", "png-screenshot", "font-and-resource-observation"]
      });
      Object.assign(preview, { status: "ready", state: "ready", observation, screenshot, renderingIdentity, evidenceManifestId: evidenceManifest.manifestId });
      this.publish("preview.ready", { previewSessionId, iframeInstanceId, slideId, state: "ready", fileIndexVersion: this.snapshot.fileIndexVersion, rendererUrl, evidenceManifestId: evidenceManifest.manifestId });
      return sendJson(response, 200, { preview: publicPreview(preview), observation, screenshot, renderingIdentity, evidenceManifest });
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : new RuntimeError("PREVIEW_RENDER_FAILED", "The renderer failed before producing a trustworthy preview.");
      const failure = publicError(runtimeError);
      const evidenceManifest = await this.writeEvidence({ result: "failed", preview, error: failure, assertions: ["preview-ready-gate"] });
      Object.assign(preview, { status: "error", state: "error", error: failure, evidenceManifestId: evidenceManifest.manifestId });
      this.publish("preview.error", { previewSessionId, iframeInstanceId, slideId, state: "error", rendererUrl, error: failure, evidenceManifestId: evidenceManifest.manifestId });
      return sendJson(response, 422, { preview: publicPreview(preview), error: failure, evidenceManifest });
    }
  }

  previewStatus(pathname, response) {
    const previewId = pathname.slice("/api/preview/".length);
    const preview = this.previews.get(previewId);
    if (!preview) return sendJson(response, 404, { error: { code: "PREVIEW_NOT_FOUND", message: "Preview session was not found.", details: {} } });
    return sendJson(response, 200, { preview: publicPreview(preview) });
  }

  events(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write(`retry: 1000\n\n`);
    const client = { response, heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15000) };
    this.sseClients.add(client);
    response.write(`event: subscription.snapshot\ndata: ${JSON.stringify({ schemaVersion: 1, streamEpoch: this.streamEpoch, sequence: this.sequence, project: this.snapshot ? publicSnapshot(this.snapshot) : null, error: this.scanFailure })}\n\n`);
    request.on("close", () => {
      clearInterval(client.heartbeat);
      this.sseClients.delete(client);
    });
  }

  publish(eventType, payload) {
    const event = {
      schemaVersion: 1,
      eventId: `${this.streamEpoch}:${this.sequence + 1}`,
      streamEpoch: this.streamEpoch,
      sequence: ++this.sequence,
      eventType,
      scope: "project",
      projectId: this.projectId,
      occurredAt: new Date().toISOString(),
      fileIndexVersion: this.snapshot?.fileIndexVersion || null,
      artifactVersionId: null,
      origin: "system",
      runId: null,
      previewSessionId: payload.previewSessionId || null,
      payload
    };
    for (const client of this.sseClients) {
      try { client.response.write(`id: ${event.eventId}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`); } catch {}
    }
    return event;
  }

  async rendererDocument(pathname, requestUrl, response) {
    const scope = this.scopeForPath(pathname);
    this.assertScopeQuery(scope, requestUrl.searchParams);
    const html = createRendererHtml({
      protocol: "shppt-bridge",
      version: 1,
      projectId: scope.projectId,
      fileIndexVersion: scope.fileIndexVersion,
      previewSessionId: scope.previewSessionId,
      iframeInstanceId: scope.iframeInstanceId,
      scopeId: scope.scopeId,
      bridgeNonce: scope.bridgeNonce,
      slideId: scope.slideId,
      entryUrl: `${this.origin}/preview/${scope.scopeId}/${encodeProjectPath(scope.entryPath)}?session=${encodeURIComponent(scope.previewSessionId)}&iframe=${encodeURIComponent(scope.iframeInstanceId)}&nonce=${encodeURIComponent(scope.bridgeNonce)}&slide=${encodeURIComponent(scope.slideId)}`,
      expectedSlideIds: this.snapshot.slides.map((slide) => slide.slideId),
      capture: requestUrl.searchParams.get("capture") === "true",
      origin: this.origin
    });
    return sendBytes(response, 200, "text/html; charset=utf-8", Buffer.from(html, "utf8"));
  }

  async previewResource(pathname, requestUrl, response) {
    const prefix = "/preview/";
    const remainder = pathname.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash <= 0) throw new RuntimeError("PREVIEW_SCOPE_INVALID", "Preview scope is missing.");
    const scopeId = remainder.slice(0, slash);
    const projectPath = decodePath(remainder.slice(slash + 1));
    const scope = this.previewScopes.get(scopeId);
    if (!scope || scope.expiresAt < Date.now()) throw new RuntimeError("PREVIEW_SCOPE_EXPIRED", "Preview scope is expired or unknown.");
    if (scope.projectId !== this.projectId || scope.fileIndexVersion !== this.snapshot?.fileIndexVersion) throw new RuntimeError("PREVIEW_VERSION_MISMATCH", "Preview scope does not match the active File Index snapshot.");
    const file = getFile(this.snapshot, projectPath);
    if (!file) throw new RuntimeError("PROJECT_RESOURCE_INVALID", "Preview Resource is not in the active File Index.");
    const isEntryDocument = file.path.toLowerCase() === this.snapshot.entryPath.toLowerCase();
    if (isEntryDocument) this.assertScopeQuery(scope, requestUrl.searchParams, true);
    const source = await readSnapshotFile(this.snapshot, file.path);
    let bytes = source.bytes;
    if (isEntryDocument) {
      const slideId = requestUrl.searchParams.get("slide") || scope.slideId;
      if (slideId !== scope.slideId || !this.snapshot.slides.some((slide) => slide.slideId === slideId)) throw new RuntimeError("DECK_SLIDE_INVALID", "Preview Slide does not match the active scope.");
      const html = injectBridge(bytes.toString("utf8"), {
         projectId: scope.projectId,
         fileIndexVersion: scope.fileIndexVersion,
         previewSessionId: scope.previewSessionId,
         iframeInstanceId: scope.iframeInstanceId,
         slideId,
         expectedSlideIds: this.snapshot.slides.map((slide) => slide.slideId),
         bridgeNonce: scope.bridgeNonce,
        origin: this.origin
      });
      bytes = Buffer.from(html, "utf8");
    }
    return sendBytes(response, 200, MIME_TYPES.get(path.extname(file.path).toLowerCase()) || "application/octet-stream", bytes);
  }

  async evidenceAsset(pathname, response) {
    const assetId = pathname.slice("/api/evidence/".length);
    const asset = this.assets.get(assetId);
    if (!asset) return sendJson(response, 404, { error: { code: "EVIDENCE_NOT_FOUND", message: "Evidence asset was not found.", details: {} } });
    const bytes = await fs.readFile(asset.path);
    return sendBytes(response, 200, asset.mediaType, bytes, { "Cache-Control": "no-store" });
  }

  scopeForPath(pathname) {
    const prefix = "/renderer/";
    const scopeId = pathname.slice(prefix.length).split("/", 1)[0];
    const scope = this.previewScopes.get(scopeId);
    if (!scope || scope.expiresAt < Date.now()) throw new RuntimeError("PREVIEW_SCOPE_EXPIRED", "Preview scope is expired or unknown.");
    return scope;
  }

  assertScopeQuery(scope, searchParams, requireSlide = true) {
    const expected = {
      session: scope.previewSessionId,
      iframe: scope.iframeInstanceId,
      nonce: scope.bridgeNonce
    };
    for (const [key, value] of Object.entries(expected)) if (searchParams.get(key) !== value) throw new RuntimeError("PREVIEW_SCOPE_INVALID", "Preview request did not match its scope.");
    if (requireSlide && searchParams.get("slide") !== scope.slideId) throw new RuntimeError("PREVIEW_SCOPE_INVALID", "Preview Slide did not match its scope.");
  }

  async writeEvidence({ result, preview, observation = null, screenshot = null, renderingIdentity = null, error = null, assertions = [] }) {
    const manifestId = randomUUID();
    const manifest = {
      schemaVersion: 1,
      manifestId,
      result,
      exitCode: result === "passed" ? 0 : null,
      command: "preview",
      buildIdentity: this.buildIdentity,
      projectId: preview.projectId,
      fileIndexVersion: preview.fileIndexVersion,
      entryPath: this.snapshot?.entryPath || null,
      slideId: preview.slideId,
      previewSessionId: preview.previewSessionId,
      iframeInstanceId: preview.iframeInstanceId,
      fixtureHash: this.snapshot?.fixtureHash || null,
      renderingIdentity,
      assertions,
      screenshot,
      bridge: observation ? {
        protocol: observation.protocol,
        version: observation.version,
        transport: "MessagePort",
        activeSlideId: observation.activeSlideId,
        slideCount: observation.slides?.length || 0,
        stableElementCount: observation.elements?.length || 0,
        fontReady: observation.fontReady,
        fontCheck: observation.fontCheck,
        imageCount: observation.images?.length || 0
      } : null,
      error,
      createdAt: new Date().toISOString()
    };
    const filePath = path.join(this.evidenceDirectory, `manifest-${manifestId}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { manifestId, result, assertions, screenshot: screenshot ? { assetId: screenshot.assetId, sha256: screenshot.sha256 } : null };
  }

  handleError(response, error) {
    if (response.headersSent) {
      try { response.end(); } catch {}
      return;
    }
    const publicFailure = publicError(error);
    const status = publicFailure.code.startsWith("HTTP_") ? 404 : 400;
    sendJson(response, status, { error: publicFailure });
  }
}

function validateObservation(observation, snapshot, scope) {
  if (!observation || observation.protocol !== "shppt-bridge" || observation.version !== 1 || !Number.isInteger(observation.sequence) || observation.sequence < 1 || observation.projectId !== snapshot.projectId || observation.fileIndexVersion !== snapshot.fileIndexVersion || observation.previewSessionId !== scope.previewSessionId || observation.iframeInstanceId !== scope.iframeInstanceId || observation.activeSlideId !== scope.slideId) {
    throw new RuntimeError("BRIDGE_OBSERVATION_INVALID", "Bridge observation identity did not match the active Project snapshot.");
  }
  const expectedSlides = snapshot.slides;
  const slideIds = new Set(expectedSlides.map((slide) => slide.slideId));
  if (!Array.isArray(observation.slides) || observation.slides.length !== expectedSlides.length || observation.slides.some((slide, index) => !slideIds.has(slide.slideId) || slide.slideId !== expectedSlides[index].slideId || slide.slideIndex !== index || !Number.isFinite(slide.rect?.width) || !Number.isFinite(slide.rect?.height) || slide.rect.width <= 1 || slide.rect.height <= 1) || new Set(observation.slides.map((slide) => slide.slideId)).size !== expectedSlides.length) throw new RuntimeError("DECK_SLIDE_INVALID", "Bridge observation did not describe the active Deck.");
  const ratios = observation.slides.map((slide) => slide.rect.width / slide.rect.height);
  if (ratios.some((ratio) => Math.abs(ratio - ratios[0]) > 0.01)) throw new RuntimeError("DECK_SLIDE_SIZE_MISMATCH", "Slide aspect ratios do not match.");
  if (!observation.activeSlideRect || observation.activeSlideRect.width <= 1 || observation.activeSlideRect.height <= 1) throw new RuntimeError("DECK_SLIDE_INVALID", "Active Slide has an empty render rectangle.");
  const activeSlide = expectedSlides.find((slide) => slide.slideId === scope.slideId);
  const knownIds = new Set(activeSlide?.stableElementIds || []);
  if (!Array.isArray(observation.elements) || observation.elements.some((element) => !knownIds.has(element.stableElementId) || !Number.isFinite(element.rect?.x) || !Number.isFinite(element.rect?.y) || !Number.isFinite(element.rect?.width) || !Number.isFinite(element.rect?.height)) || new Set(observation.elements.map((element) => element.stableElementId)).size !== observation.elements.length) throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Bridge reported an unknown or duplicate Stable Element ID.");
  if (observation.images?.some((image) => !image.complete || image.width <= 0 || image.height <= 0)) throw new RuntimeError("PROJECT_RESOURCE_INVALID", "A required image Resource did not load.");
  if (observation.fontReady === false || observation.fontCheck === false) throw new RuntimeError("PROJECT_RESOURCE_INVALID", "The fixed local font did not load.");
  return observation;
}

function inspectPng(bytes, expectedWidth, expectedHeight) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) return { valid: false, nonEmpty: false, width: 0, height: 0 };
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR" && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }
  const validDimensions = width === expectedWidth && height === expectedHeight && width > 0 && height > 0;
  let nonEmpty = validDimensions;
  try {
    if (bitDepth === 8 && [2, 6].includes(colorType) && idat.length) {
      const raw = zlib.inflateSync(Buffer.concat(idat));
      const bytesPerPixel = colorType === 6 ? 4 : 3;
      const stride = width * bytesPerPixel;
      let previous = Buffer.alloc(stride);
      const colors = new Set();
      let cursor = 0;
      for (let row = 0; row < height; row++) {
        const filter = raw[cursor++];
        const current = Buffer.alloc(stride);
        for (let index = 0; index < stride; index++) {
          const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
          const above = previous[index] || 0;
          const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] || 0 : 0;
          const value = raw[cursor++];
          if (filter === 0) current[index] = value;
          else if (filter === 1) current[index] = (value + left) & 255;
          else if (filter === 2) current[index] = (value + above) & 255;
          else if (filter === 3) current[index] = (value + Math.floor((left + above) / 2)) & 255;
          else if (filter === 4) current[index] = (value + paeth(left, above, upperLeft)) & 255;
          else current[index] = value;
        }
        for (let index = 0; index < stride; index += bytesPerPixel * 8) colors.add(current.subarray(index, index + Math.min(bytesPerPixel, 3)).toString("hex"));
        previous = current;
      }
      nonEmpty = validDimensions && colors.size > 4;
    }
  } catch {
    nonEmpty = false;
  }
  return { valid: validDimensions && offset <= bytes.length, nonEmpty, width, height };
}

function paeth(left, above, upperLeft) {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
}

function normalizeViewport(value) {
  const width = Number(value?.width ?? 1280);
  const height = Number(value?.height ?? 720);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || width > 2400 || height < 360 || height > 1600) throw new RuntimeError("PREVIEW_VIEWPORT_INVALID", "Preview viewport is outside the supported bounds.");
  return { width, height };
}

function normalizeDpr(value) {
  const dpr = Number(value ?? 1);
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) throw new RuntimeError("PREVIEW_DPR_INVALID", "Preview DPR is outside the supported bounds.");
  return dpr;
}

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { throw new RuntimeError("PROJECT_PATH_ESCAPE", "Preview Resource path is not encoded correctly."); }
}

function encodeProjectPath(value) {
  return validateProjectRelativePath(value).split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function publicPreview(preview) {
  return JSON.parse(JSON.stringify(preview));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new RuntimeError("HTTP_BODY_TOO_LARGE", "Request body exceeds the supported bound.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RuntimeError("HTTP_JSON_INVALID", "Request body is not valid JSON."); }
}

function sendJson(response, status, body) {
  return sendBytes(response, status, "application/json; charset=utf-8", Buffer.from(`${JSON.stringify(body)}\n`, "utf8"));
}

function sendBytes(response, status, contentType, bytes, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": bytes.length, ...extraHeaders });
  response.end(bytes);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = { port: 0, browser: "chrome", build: DEFAULT_BUILD_IDENTITY };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--content-root") options.contentRoot = next;
    else if (arg === "--port") options.port = Number(next);
    else if (arg === "--state-dir") options.stateDirectory = next;
    else if (arg === "--evidence-dir") options.evidenceDirectory = next;
    else if (arg === "--browser") options.browserName = next;
    else if (arg === "--browser-path") options.browserPath = next;
    else if (arg === "--build") options.buildIdentity = next;
    if (["--content-root", "--port", "--state-dir", "--evidence-dir", "--browser", "--browser-path", "--build"].includes(arg)) index++;
  }
  if (!options.contentRoot) throw new RuntimeError("PROJECT_ROOT_INVALID", "--content-root is required.");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new RuntimeError("HTTP_PORT_INVALID", "--port must be a valid TCP port.");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const daemon = new LocalDaemon(options);
  daemon.start().then((started) => {
    process.stdout.write(`${JSON.stringify({ event: "listening", origin: started.origin, projectId: started.projectId, fileIndexVersion: started.snapshot?.fileIndexVersion || null, scanError: started.scanFailure })}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  });
  const stop = () => daemon.stop().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
