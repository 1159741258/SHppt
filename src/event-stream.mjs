import { randomUUID } from "node:crypto";

export class ProjectEventLog {
  constructor({ projectId, historyLimit = 256, epoch = randomUUID(), now = () => new Date() }) {
    this.projectId = projectId;
    this.historyLimit = historyLimit;
    this.epoch = epoch;
    this.now = now;
    this.sequence = 0;
    this.history = [];
  }

  publish(eventType, options = {}) {
    const sequence = ++this.sequence;
    const event = {
      schemaVersion: 1,
      eventId: `${this.epoch}:${sequence}`,
      streamEpoch: this.epoch,
      sequence,
      eventType,
      scope: options.scope || "project",
      projectId: this.projectId,
      occurredAt: this.now().toISOString(),
      fileIndexVersion: options.fileIndexVersion ?? null,
      artifactVersionId: options.artifactVersionId ?? null,
      origin: normalizeOrigin(options.origin),
      runId: options.runId ?? null,
      previewSessionId: options.previewSessionId ?? null,
      payload: options.payload || {}
    };
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    return event;
  }

  recovery(lastEventId, snapshot, error = null, snapshotPayload = {}) {
    if (!lastEventId) return { kind: "snapshot", events: [this.subscriptionSnapshot(snapshot, error, snapshotPayload)] };
    const cursor = parseEventId(lastEventId);
    const oldestSequence = this.history[0]?.sequence ?? this.sequence + 1;
    if (!cursor || cursor.epoch !== this.epoch || cursor.sequence > this.sequence || cursor.sequence < oldestSequence - 1) {
      return { kind: "resync", events: [this.resyncRequired(snapshot)] };
    }
    return { kind: "replay", events: this.history.filter((event) => event.sequence > cursor.sequence) };
  }

  subscriptionSnapshot(snapshot, error = null, snapshotPayload = {}) {
    return {
      schemaVersion: 1,
      eventId: `${this.epoch}:${this.sequence}`,
      streamEpoch: this.epoch,
      sequence: this.sequence,
      eventType: "subscription.snapshot",
      scope: "project",
      projectId: this.projectId,
      occurredAt: this.now().toISOString(),
      fileIndexVersion: snapshot?.fileIndexVersion ?? null,
      artifactVersionId: null,
      origin: "system",
      runId: null,
      previewSessionId: null,
      payload: { project: snapshot, ...snapshotPayload, error }
    };
  }

  resyncRequired(snapshot) {
    return {
      schemaVersion: 1,
      eventId: `${this.epoch}:${this.sequence}`,
      streamEpoch: this.epoch,
      sequence: this.sequence,
      eventType: "subscription.resync-required",
      scope: "project",
      projectId: this.projectId,
      occurredAt: this.now().toISOString(),
      fileIndexVersion: snapshot?.fileIndexVersion ?? null,
      artifactVersionId: null,
      origin: "system",
      runId: null,
      previewSessionId: null,
      payload: {
        reason: "EVENT_CURSOR_GAP",
        latestEventId: `${this.epoch}:${this.sequence}`,
        fileIndexVersion: snapshot?.fileIndexVersion ?? null
      }
    };
  }
}

function parseEventId(value) {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const sequence = Number(value.slice(separator + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { epoch: value.slice(0, separator), sequence };
}

function normalizeOrigin(value) {
  return ["agent", "external", "system", "unknown"].includes(value) ? value : "unknown";
}
