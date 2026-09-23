import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectEventLog } from "../src/event-stream.mjs";
import { StableProjectObserver, WatcherRegistry } from "../src/watcher.mjs";

test("WATCH-01 merges repeated writes and publishes only after two stable scans", async () => {
  const clock = new FakeClock();
  const pending = [];
  const stable = [];
  const snapshots = [snapshot("v2"), snapshot("v2")];
  const observer = new StableProjectObserver({
    scan: async () => snapshots.shift(),
    initialSnapshot: snapshot("v1"),
    stabilityWindowMs: 10,
    maxStabilityWaitMs: 100,
    clock,
    onPending: (event) => pending.push(event),
    onStable: (event) => stable.push(event)
  });

  observer.notify({ path: "index.html" });
  observer.notify({ path: "index.html" });
  observer.notify({ path: "styles/deck.css" });
  assert.equal(pending.length, 1);
  assert.equal(stable.length, 0);

  await clock.advance(10);
  assert.equal(stable.length, 0);
  await clock.advance(10);
  assert.equal(stable.length, 1);
  assert.deepEqual(stable[0].paths, ["index.html", "styles/deck.css"]);
  assert.equal(stable[0].previousSnapshot.fileIndexVersion, "v1");
  assert.equal(stable[0].snapshot.fileIndexVersion, "v2");
});

test("WATCH-02 reports a deterministic timeout instead of accepting moving content", async () => {
  const clock = new FakeClock();
  const timeouts = [];
  let version = 1;
  const observer = new StableProjectObserver({
    scan: async () => snapshot(`v${version++}`),
    initialSnapshot: snapshot("v0"),
    stabilityWindowMs: 10,
    maxStabilityWaitMs: 25,
    clock,
    onTimeout: (event) => timeouts.push(event)
  });

  observer.notify({ path: "index.html" });
  await clock.advance(10);
  await clock.advance(10);
  await clock.advance(10);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].error.code, "FILE_STABILITY_TIMEOUT");
});

test("WATCH-03 reuses one native watcher until the final lease is released", () => {
  let created = 0;
  let closed = 0;
  let emit;
  const registry = new WatcherRegistry({
    watchFactory: (_root, callback) => {
      created++;
      emit = callback;
      return { close: () => { closed++; } };
    }
  });
  const firstEvents = [];
  const secondEvents = [];
  const first = registry.acquire("C:\\Deck", (event) => firstEvents.push(event));
  const second = registry.acquire("c:\\deck\\", (event) => secondEvents.push(event));

  assert.equal(created, 1);
  assert.equal(registry.size, 1);
  emit({ path: "index.html" });
  assert.equal(firstEvents.length, 1);
  assert.equal(secondEvents.length, 1);
  first.release();
  assert.equal(closed, 0);
  second.release();
  assert.equal(closed, 1);
  assert.equal(registry.size, 0);
});

test("WATCH-04 never forwards absolute or parent-relative paths", () => {
  const clock = new FakeClock();
  const pending = [];
  const observer = new StableProjectObserver({
    scan: async () => snapshot("v1"),
    initialSnapshot: snapshot("v1"),
    stabilityWindowMs: 10,
    maxStabilityWaitMs: 100,
    clock,
    onPending: (event) => pending.push(event)
  });
  observer.notify({ path: "C:\\private\\deck.html" });
  observer.notify({ path: "../private/deck.html" });
  observer.notify({ path: ".git/config" });
  assert.equal(pending.length, 0);
});

test("EVENT-01 replays a continuous cursor and requires resync for another epoch", () => {
  const now = () => new Date("2026-09-23T00:00:00.000Z");
  const log = new ProjectEventLog({ projectId: "project-1", epoch: "epoch-1", historyLimit: 2, now });
  const first = log.publish("project.file-change-pending", { fileIndexVersion: "v1" });
  const second = log.publish("project.file-changed", { fileIndexVersion: "v2" });

  const replay = log.recovery(first.eventId, { fileIndexVersion: "v2" });
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.events.map((event) => event.eventId), [second.eventId]);
  assert.equal(replay.events[0].sequence, first.sequence + 1);

  const wrongEpoch = log.recovery("old-epoch:2", { fileIndexVersion: "v2" });
  assert.equal(wrongEpoch.kind, "resync");
  assert.equal(wrongEpoch.events[0].eventType, "subscription.resync-required");
  assert.equal(wrongEpoch.events[0].payload.reason, "EVENT_CURSOR_GAP");
});

test("EVENT-02 reports an evicted cursor instead of applying a partial replay", () => {
  const log = new ProjectEventLog({ projectId: "project-1", epoch: "epoch-1", historyLimit: 2 });
  log.publish("one");
  log.publish("two");
  log.publish("three");
  assert.equal(log.recovery("epoch-1:0", snapshot("v3")).kind, "resync");
  assert.equal(log.recovery("epoch-1:1", snapshot("v3")).kind, "replay");
});

function snapshot(fileIndexVersion) {
  return { fileIndexVersion };
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = [];
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const timer = { id: this.nextId++, at: this.time + delay, callback, cancelled: false };
    this.timers.push(timer);
    return timer.id;
  };

  clearTimeout = (id) => {
    const timer = this.timers.find((candidate) => candidate.id === id);
    if (timer) timer.cancelled = true;
  };

  async advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      this.timers.sort((left, right) => left.at - right.at);
      const timer = this.timers.find((candidate) => !candidate.cancelled && candidate.at <= target);
      if (!timer) break;
      timer.cancelled = true;
      this.time = timer.at;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
  }
}
