import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeError } from "./errors.mjs";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export async function findBrowser(browserName = "chrome") {
  const candidates = browserName === "edge"
    ? [
        process.env.SHPPT_EDGE_PATH,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
      ]
    : [
        process.env.SHPPT_CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      ];
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate;
  }
  throw new RuntimeError("RENDERER_BROWSER_NOT_FOUND", `The configured ${browserName} browser executable was not found.`);
}

export class CdpRenderer {
  constructor({ browserName = "chrome", browserPath = null, viewport = DEFAULT_VIEWPORT, dpr = 1, hostOrigin, onDiagnostic = () => {} }) {
    this.browserName = browserName;
    this.browserPath = browserPath;
    this.viewport = viewport;
    this.dpr = dpr;
    this.hostOrigin = hostOrigin;
    this.onDiagnostic = onDiagnostic;
    this.browser = null;
  }

  async render({ rendererUrl, slideIds, screenshotDirectory }) {
    const browserPath = this.browserPath || await findBrowser(this.browserName);
    const runtime = await launchBrowser(browserPath, this.viewport, this.dpr);
    this.browser = runtime;
    let page = null;
    try {
      page = await CdpPage.connect(runtime.pageWebSocketUrl);
      await page.call("Page.enable");
      await page.call("Runtime.enable");
      await page.call("Emulation.setDeviceMetricsOverride", {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: this.dpr,
        mobile: false
      });
      await page.navigate(rendererUrl);
      await page.waitForLoadEvent(15000);
      let ready;
      try {
        ready = await page.waitForFunction("window.__shpptBridgeReady && window.__shpptBridgeReady()", 15000);
      } catch (error) {
        const state = await page.evaluate("window.__shpptRendererState && ({status: window.__shpptRendererState.status, handshake: window.__shpptRendererState.handshake, error: window.__shpptRendererState.error})").catch(() => null);
        throw new RuntimeError(error.code || "PREVIEW_BRIDGE_TIMEOUT", error.message, { state, browserException: page.lastException });
      }
      if (!ready) throw new RuntimeError("PREVIEW_BRIDGE_NOT_READY", "The preview did not complete a valid Bridge handshake.");
      const observation = await page.evaluate("window.__shpptRendererState && window.__shpptRendererState.observation");
      if (!observation) throw new RuntimeError("PREVIEW_DOM_OBSERVATION_EMPTY", "The preview did not produce a DOM observation.");
      const screenshots = {};
      await fs.mkdir(screenshotDirectory, { recursive: true });
      for (const slideId of slideIds) {
        await page.evaluate(`window.__shpptSelectSlide && window.__shpptSelectSlide(${JSON.stringify(slideId)})`);
        await page.waitForFunction(`window.__shpptRendererState && window.__shpptRendererState.observation && window.__shpptRendererState.observation.activeSlideId === ${JSON.stringify(slideId)}`, 5000);
        await page.evaluate("window.__shpptSetCaptureMode && window.__shpptSetCaptureMode(true)");
        await delay(50);
        const png = await page.captureScreenshot({ format: "png", captureBeyondViewport: false });
        const screenshotPath = path.join(screenshotDirectory, `${slideId}.png`);
        await fs.writeFile(screenshotPath, png);
        screenshots[slideId] = { path: screenshotPath, bytes: png.length };
        await page.evaluate("window.__shpptSetCaptureMode && window.__shpptSetCaptureMode(false)");
      }
      return { observation, screenshots, browserVersion: runtime.browserVersion, viewport: this.viewport, dpr: this.dpr };
    } catch (error) {
      this.onDiagnostic(error);
      throw error instanceof RuntimeError ? error : new RuntimeError("PREVIEW_RENDER_FAILED", "The browser renderer failed to produce a preview.");
    } finally {
      await page?.close().catch(() => {});
      await runtime.close();
      this.browser = null;
    }
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

async function launchBrowser(browserPath, viewport, dpr) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-render-"));
  const userDataDirectory = path.join(root, "profile");
  const port = await findFreePort();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--hide-scrollbars",
    `--window-size=${viewport.width},${viewport.height}`,
    `--force-device-scale-factor=${dpr}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDirectory}`,
    "about:blank"
  ];
  let child;
  try {
    child = spawn(browserPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw new RuntimeError("RENDERER_BROWSER_START_FAILED", "The browser process could not be started.", { reason: error.message });
  }
  let stderr = "";
  let spawnError = null;
  child.on("error", (error) => { spawnError = error; });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
  });
  const startedAt = Date.now();
  let pageWebSocketUrl;
  let browserVersion = null;
  while (Date.now() - startedAt < 15000) {
    if (spawnError) {
      await fs.rm(root, { recursive: true, force: true });
      throw new RuntimeError("RENDERER_BROWSER_START_FAILED", "The browser process could not be started.", { reason: spawnError.message });
    }
    if (child.exitCode !== null) {
      await fs.rm(root, { recursive: true, force: true });
      throw new RuntimeError("RENDERER_BROWSER_START_FAILED", "The browser exited before the DevTools endpoint became available.", { stderr: redactBrowserOutput(stderr) });
    }
    try {
      const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (versionResponse.ok) browserVersion = await versionResponse.json();
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        pageWebSocketUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // The browser may need a few cycles before its DevTools HTTP endpoint is ready.
    }
    await delay(100);
  }
  if (!pageWebSocketUrl) {
    try { child.kill(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
    throw new RuntimeError("RENDERER_BROWSER_START_FAILED", "The browser DevTools endpoint did not become available.", { stderr: redactBrowserOutput(stderr) });
  }
  return {
    child,
    pageWebSocketUrl,
    browserVersion,
    async close() {
      try { child.kill(); } catch {}
      await delay(100);
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

class CdpPage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.lastException = null;
    socket.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeError("RENDERER_CDP_CONNECT_FAILED", "The renderer DevTools connection timed out.")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new RuntimeError("RENDERER_CDP_CONNECT_FAILED", "The renderer DevTools connection failed.")); }, { once: true });
    });
    return new CdpPage(socket);
  }

  onMessage(message) {
    if (message.method === "Runtime.exceptionThrown") {
      this.lastException = { text: message.params?.exceptionDetails?.text || "runtime exception" };
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RuntimeError("RENDERER_CDP_COMMAND_FAILED", "The renderer command failed."));
      else pending.resolve(message);
      return;
    }
    const handlers = this.events.get(message.method) || [];
    for (const handler of handlers) handler(message.params || {});
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const handler = (params) => {
        const handlers = this.events.get(method) || [];
        this.events.set(method, handlers.filter((item) => item !== handler));
        resolve(params);
      };
      this.events.set(method, [...(this.events.get(method) || []), handler]);
    });
  }

  async navigate(url) {
    await this.call("Page.navigate", { url });
  }

  async waitForLoadEvent(timeout) {
    await Promise.race([
      this.once("Page.loadEventFired"),
      delay(timeout).then(() => { throw new RuntimeError("PREVIEW_LOAD_TIMEOUT", "The renderer page did not finish loading."); })
    ]);
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return response.result?.result?.value;
  }

  async waitForFunction(expression, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value) return value;
      await delay(50);
    }
    throw new RuntimeError("PREVIEW_BRIDGE_TIMEOUT", "The renderer did not reach the requested state in time.");
  }

  async captureScreenshot(options) {
    const response = await this.call("Page.captureScreenshot", options);
    return Buffer.from(response.result.data, "base64");
  }

  async close() {
    try { this.socket.close(); } catch {}
  }
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function redactBrowserOutput(value) {
  return String(value ?? "").replace(/[A-Za-z]:\\[^\r\n]+/g, "[redacted-path]").slice(-512);
}
