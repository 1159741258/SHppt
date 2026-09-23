import { watch } from "node:fs";
import path from "node:path";
import { RuntimeError, publicError } from "./errors.mjs";

const DEFAULT_CLOCK = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer)
};

export class WatcherRegistry {
  constructor({ watchFactory = createNativeWatcher } = {}) {
    this.watchFactory = watchFactory;
    this.records = new Map();
  }

  acquire(contentRoot, listener) {
    const key = canonicalKey(contentRoot);
    let record = this.records.get(key);
    if (!record) {
      const listeners = new Set();
      const watcher = this.watchFactory(contentRoot, (event) => {
        for (const current of listeners) current(event);
      });
      record = { contentRoot, watcher, listeners, leases: 0 };
      this.records.set(key, record);
    }
    record.leases++;
    record.listeners.add(listener);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        record.listeners.delete(listener);
        record.leases--;
        if (record.leases === 0) {
          record.watcher.close();
          this.records.delete(key);
        }
      }
    };
  }

  get size() {
    return this.records.size;
  }
}

export class StableProjectObserver {
  constructor({ scan, initialSnapshot, stabilityWindowMs = 200, maxStabilityWaitMs = 10000, clock = DEFAULT_CLOCK, onPending = () => {}, onStable = () => {}, onFailure = () => {}, onTimeout = () => {} }) {
    if (stabilityWindowMs <= 0 || maxStabilityWaitMs < stabilityWindowMs) throw new TypeError("Invalid file stability configuration.");
    this.scan = scan;
    this.snapshot = initialSnapshot;
    this.stabilityWindowMs = stabilityWindowMs;
    this.maxStabilityWaitMs = maxStabilityWaitMs;
    this.clock = clock;
    this.onPending = onPending;
    this.onStable = onStable;
    this.onFailure = onFailure;
    this.onTimeout = onTimeout;
    this.batch = null;
    this.timer = null;
    this.running = false;
  }

  notify({ eventType = "change", path: projectPath = null, origin = "unknown", error = null } = {}) {
    if (error) {
      const watcherError = new RuntimeError("WATCHER_UNAVAILABLE", "The Project watcher stopped unexpectedly.", { cause: error.code || "unknown" });
      this.onFailure({ error: publicError(watcherError), paths: [], origin: "system", configuration: this.configuration() });
      return;
    }
    const safePath = projectPath ? normalizeProjectPath(projectPath) : null;
    if (projectPath && !safePath) return;
    if (safePath && isProtectedPath(safePath)) return;
    if (!this.batch) {
      this.batch = { startedAt: this.clock.now(), generation: 0, paths: new Set(), origins: new Set(), firstResult: null };
      this.onPending({ paths: safePath ? [safePath] : [], origin, configuration: this.configuration() });
    }
    if (safePath) this.batch.paths.add(safePath);
    this.batch.origins.add(origin);
    this.batch.generation++;
    this.batch.firstResult = null;
    this.schedule(this.stabilityWindowMs);
  }

  async check() {
    if (!this.batch || this.running) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.running = true;
    const batch = this.batch;
    const generation = batch.generation;
    let result;
    try {
      result = { ok: true, snapshot: await this.scan() };
    } catch (error) {
      result = { ok: false, error: publicError(error) };
    } finally {
      this.running = false;
    }
    if (this.batch !== batch) return;
    if (this.clock.now() - batch.startedAt >= this.maxStabilityWaitMs) return this.timeout(batch);
    if (generation !== batch.generation) return this.schedule(this.stabilityWindowMs);
    if (!batch.firstResult || !sameResult(batch.firstResult, result)) {
      batch.firstResult = result;
      return this.schedule(this.stabilityWindowMs);
    }
    this.finish(batch, result);
  }

  cancel() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.batch = null;
  }

  configuration() {
    return { stabilityWindowMs: this.stabilityWindowMs, maxStabilityWaitMs: this.maxStabilityWaitMs };
  }

  schedule(delay) {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
  }

  finish(batch, result) {
    this.batch = null;
    this.timer = null;
    const details = {
      paths: [...batch.paths].sort((left, right) => left.localeCompare(right)),
      origin: collapseOrigin(batch.origins),
      configuration: this.configuration()
    };
    if (!result.ok) {
      this.onFailure({ ...details, error: result.error });
      return;
    }
    const previousSnapshot = this.snapshot;
    this.snapshot = result.snapshot;
    this.onStable({ ...details, previousSnapshot, snapshot: result.snapshot });
  }

  timeout(batch) {
    this.batch = null;
    this.timer = null;
    this.onTimeout({
      paths: [...batch.paths].sort((left, right) => left.localeCompare(right)),
      origin: collapseOrigin(batch.origins),
      configuration: this.configuration(),
      error: { code: "FILE_STABILITY_TIMEOUT", message: "Project files did not become stable before the configured deadline.", details: {} }
    });
  }
}

function createNativeWatcher(contentRoot, emit) {
  const watcher = watch(contentRoot, { recursive: true }, (eventType, filename) => {
    emit({ eventType, path: filename ? String(filename).split(path.sep).join("/") : null, origin: "unknown" });
  });
  watcher.on("error", (error) => emit({ error }));
  return watcher;
}

function sameResult(left, right) {
  if (left.ok !== right.ok) return false;
  if (left.ok) return left.snapshot.fileIndexVersion === right.snapshot.fileIndexVersion;
  return left.error.code === right.error.code && left.error.message === right.error.message;
}

function collapseOrigin(origins) {
  return origins.size === 1 ? [...origins][0] : "unknown";
}

function canonicalKey(contentRoot) {
  return path.resolve(contentRoot).replace(/[\\/]+$/, "").toLowerCase();
}

function normalizeProjectPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0") || normalized.includes(":")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function isProtectedPath(value) {
  const parts = value.toLowerCase().split("/");
  return parts.some((part) => part === ".git" || part === ".shppt");
}

export const defaultWatcherRegistry = new WatcherRegistry();
