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
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, "[redacted-path]")
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
  if (!details || typeof details !== "object") return {};
  const output = {};
  for (const [key, value] of Object.entries(details)) {
    if (/contentRoot|absolutePath|prompt|credential|token|secret|password/i.test(key)) continue;
    if (typeof value === "string") output[key] = redactText(value);
    else if (Array.isArray(value)) output[key] = value.slice(0, 32).map((item) => typeof item === "string" ? redactText(item) : item);
    else output[key] = value;
  }
  return output;
}
