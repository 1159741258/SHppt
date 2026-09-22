export class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function isRuntimeError(error) {
  return error instanceof RuntimeError || Boolean(error && typeof error.code === "string");
}

export function redactText(value) {
  return String(value ?? "")
    .replace(/[A-Za-z]:[\\/][^\r\n"']+/g, "[redacted-path]")
    .replace(/\\\\[^\r\n"']+/g, "[redacted-path]")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function publicError(error) {
  if (isRuntimeError(error)) {
    return {
      code: error.code,
      message: redactText(error.message),
      details: redactDetails(error.details)
    };
  }
  return {
    code: "RUNTIME_INTERNAL_ERROR",
    message: "The local runtime could not complete the request.",
    details: {}
  };
}

function redactDetails(details) {
  const output = redactValue(details, "", 0, new WeakSet());
  return output && typeof output === "object" && !Array.isArray(output) ? output : {};
}

function redactValue(value, key, depth, seen) {
  if (/contentRoot|absolutePath|prompt|credential|token|secret|password|authorization|cookie/i.test(key)) return undefined;
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4 || seen.has(value)) return "[redacted]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactValue(item, "", depth + 1, seen));
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const redacted = redactValue(childValue, childKey, depth + 1, seen);
    if (redacted !== undefined) output[childKey] = redacted;
  }
  return output;
}
