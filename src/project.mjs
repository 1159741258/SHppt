import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RuntimeError } from "./errors.mjs";

export const CONTRACT_VERSION = 1;
export const PROJECT_TYPE = "html-deck";
export const PROTECTED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".shppt", "node_modules", "dist", "build", "coverage"]);
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export function createProjectId() {
  return randomUUID();
}

export async function canonicalizeContentRoot(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "Content Root must be a non-empty local directory.");
  }
  const candidate = path.resolve(input);
  if (candidate.startsWith("\\\\") || candidate.startsWith("//")) {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "UNC and network Content Roots are not supported.");
  }
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "Content Root does not exist or cannot be read.");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "Content Root must be an ordinary local directory.");
  }
  let realPath;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "Content Root cannot be canonicalized.");
  }
  if (realPath.startsWith("\\\\") || realPath.startsWith("//")) {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "UNC and network Content Roots are not supported.");
  }
  return realPath;
}

export async function loadOrCreateProjectId(stateDirectory, contentRoot) {
  const statePath = path.join(stateDirectory, "projects.json");
  await fs.mkdir(stateDirectory, { recursive: true });
  let state = { projects: {} };
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (!state || typeof state !== "object" || !state.projects || typeof state.projects !== "object") {
      state = { projects: {} };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new RuntimeError("PROJECT_STATE_INVALID", "Trusted Project state cannot be read.");
    }
  }
  const key = contentRoot.toLowerCase();
  let projectId = state.projects[key]?.projectId;
  if (!PROJECT_ID_PATTERN.test(projectId ?? "")) projectId = createProjectId();
  state.projects[key] = { projectId, contentRoot };
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, statePath);
  return projectId;
}

export async function scanProject({ contentRoot, projectId }) {
  const root = await canonicalizeContentRoot(contentRoot);
  if (typeof projectId !== "string" || !projectId) projectId = createProjectId();

  const manifestPath = await findCaseInsensitiveFile(root, "shppt.json");
  let entryPath;
  let manifestEntry = null;
  if (manifestPath) {
    await ordinaryFileStat(manifestPath, "PROJECT_MANIFEST_INVALID");
    const manifest = await readJsonFile(manifestPath, "PROJECT_MANIFEST_INVALID");
    const keys = Object.keys(manifest);
    if (keys.some((key) => !["schemaVersion", "entry"].includes(key)) || manifest.schemaVersion !== 1 || typeof manifest.entry !== "string" || manifest.entry.trim() === "") {
      throw new RuntimeError("PROJECT_MANIFEST_INVALID", "shppt.json must contain only schemaVersion 1 and a non-empty entry.");
    }
    entryPath = validateProjectRelativePath(manifest.entry, "PROJECT_PATH_ESCAPE");
    if (!HTML_EXTENSIONS.has(path.posix.extname(entryPath).toLowerCase())) {
      throw new RuntimeError("PROJECT_MANIFEST_INVALID", "Manifest entry must be an HTML document.");
    }
    manifestEntry = toProjectPath(root, manifestPath);
  } else {
    const fallback = await findCaseInsensitiveFile(root, "index.html");
    if (!fallback) throw new RuntimeError("PROJECT_ENTRY_NOT_FOUND", "No manifest or root index.html was found.");
    entryPath = toProjectPath(root, fallback);
  }

  const entryAbsolute = await resolveProjectFile(root, entryPath, "PROJECT_ENTRY_NOT_FOUND");
  const entryStat = await ordinaryFileStat(entryAbsolute, "PROJECT_ENTRY_INVALID");
  if (!HTML_EXTENSIONS.has(path.extname(entryAbsolute).toLowerCase())) {
    throw new RuntimeError("PROJECT_ENTRY_INVALID", "Entry Document must be an HTML file.");
  }

  const files = new Map();
  if (manifestEntry) await addIndexedFile(files, root, manifestEntry, "manifest", true, false);
  await addIndexedFile(files, root, entryPath, "html", true, true);

  const queue = [entryPath];
  const visited = new Set();
  let deck;
  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (visited.has(currentPath.toLowerCase())) continue;
    visited.add(currentPath.toLowerCase());
    const absolutePath = await resolveProjectFile(root, currentPath, "PROJECT_RESOURCE_INVALID");
    const bytes = await fs.readFile(absolutePath);
    const text = bytes.toString("utf8");
    if (currentPath.toLowerCase() === entryPath.toLowerCase()) {
      deck = parseEntryDocument(text, entryPath);
      for (const resource of collectHtmlResources(text, entryPath)) {
        const registered = await registerResource(files, root, resource);
        if (registered) queue.push(registered);
      }
    } else if (path.posix.extname(currentPath).toLowerCase() === ".css") {
      for (const resource of collectCssResources(text, currentPath)) {
        const registered = await registerResource(files, root, resource);
        if (registered) queue.push(registered);
      }
    } else if ([".js", ".mjs", ".cjs"].includes(path.posix.extname(currentPath).toLowerCase())) {
      for (const resource of collectScriptResources(text, currentPath)) {
        const registered = await registerResource(files, root, resource);
        if (registered) queue.push(registered);
      }
    }
  }

  if (!deck || deck.slides.length === 0) {
    throw new RuntimeError("DECK_NO_SLIDES", "Entry Document does not contain a Slide.");
  }

  const sortedFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "base" }));
  const versionInput = sortedFiles.map((file) => `${file.path.toLowerCase()}\0${file.contentHash ?? ""}`).join("\n");
  const fileIndexVersion = `sha256:${sha256(versionInput)}`;
  const snapshot = {
    projectId,
    type: PROJECT_TYPE,
    entryPath,
    contractVersion: CONTRACT_VERSION,
    slides: deck.slides,
    files: sortedFiles,
    fileIndexVersion,
    fixtureHash: `sha256:${sha256(sortedFiles.map((file) => `${file.path}\0${file.contentHash ?? ""}`).join("\n"))}`,
    scannedAt: new Date().toISOString(),
    contentRoot: root,
    entryStat
  };
  return snapshot;
}

export function publicSnapshot(snapshot) {
  const { contentRoot, entryStat, ...publicPart } = snapshot;
  return JSON.parse(JSON.stringify(publicPart));
}

export function getFile(snapshot, projectPath) {
  const normalized = validateProjectRelativePath(projectPath, "PROJECT_PATH_ESCAPE");
  return snapshot.files.find((file) => file.path.toLowerCase() === normalized.toLowerCase()) ?? null;
}

export async function readSnapshotFile(snapshot, projectPath) {
  const file = getFile(snapshot, projectPath);
  if (!file) throw new RuntimeError("PROJECT_RESOURCE_INVALID", "Resource is not part of the active File Index.");
  const absolutePath = await resolveProjectFile(snapshot.contentRoot, file.path, "PROJECT_PATH_ESCAPE");
  const stat = await ordinaryFileStat(absolutePath, "PROJECT_RESOURCE_INVALID");
  const bytes = await fs.readFile(absolutePath);
  const contentHash = `sha256:${sha256(bytes)}`;
  if (contentHash !== file.contentHash) throw new RuntimeError("PROJECT_VERSION_MISMATCH", "Resource bytes no longer match the active File Index.");
  return { file, bytes, absolutePath, stat };
}

export function validateProjectRelativePath(value, errorCode = "PROJECT_PATH_ESCAPE") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0")) {
    throw new RuntimeError(errorCode, "Path is not a valid Project-relative Path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new RuntimeError(errorCode, "Path contains an invalid Project-relative segment.");
  }
  if (parts.some((part) => PROTECTED_DIRECTORIES.has(part.toLowerCase()))) {
    throw new RuntimeError("PROJECT_PROTECTED_PATH", "Protected paths are not Project Resources.");
  }
  return parts.join("/");
}

async function registerResource(files, root, resource) {
  const normalized = validateResourceReference(resource.raw, resource.fromPath);
  if (normalized === null) return null;
  const absolutePath = await resolveProjectFile(root, normalized, "PROJECT_RESOURCE_INVALID");
  const stat = await ordinaryFileStat(absolutePath, "PROJECT_RESOURCE_INVALID");
  await addIndexedFile(files, root, normalized, kindForPath(normalized), false, false, stat);
  return normalized;
}

async function addIndexedFile(files, root, projectPath, kind, entryCandidate, previewable, knownStat = null) {
  const normalized = validateProjectRelativePath(projectPath, "PROJECT_PATH_ESCAPE");
  if (files.has(normalized.toLowerCase())) return;
  const absolutePath = await resolveProjectFile(root, normalized, "PROJECT_PATH_ESCAPE");
  const stat = knownStat ?? await ordinaryFileStat(absolutePath, "PROJECT_RESOURCE_INVALID");
  const bytes = await fs.readFile(absolutePath);
  files.set(normalized.toLowerCase(), {
    path: normalized,
    kind,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    contentHash: `sha256:${sha256(bytes)}`,
    entryCandidate: Boolean(entryCandidate),
    previewable: Boolean(previewable),
    protected: false
  });
}

async function ordinaryFileStat(absolutePath, errorCode) {
  let stat;
  try {
    const link = await fs.lstat(absolutePath);
    if (link.isSymbolicLink()) throw new Error("reparse");
    stat = await fs.stat(absolutePath);
  } catch {
    throw new RuntimeError(errorCode, "A Project file is missing, inaccessible, or not an ordinary file.");
  }
  if (!stat.isFile()) throw new RuntimeError(errorCode, "A Project Resource is not an ordinary file.");
  return stat;
}

async function resolveProjectFile(root, projectPath, errorCode) {
  const normalized = validateProjectRelativePath(projectPath, errorCode);
  const absolutePath = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RuntimeError("PROJECT_PATH_ESCAPE", "Project-relative Path escapes the Content Root.");
  }
  const segments = relative.split(path.sep);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const link = await fs.lstat(current);
      if (link.isSymbolicLink()) throw new RuntimeError("PROJECT_PATH_ESCAPE", "Reparse points are not Project Resources.");
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(errorCode, "A Project path cannot be resolved.");
    }
  }
  return absolutePath;
}

async function findCaseInsensitiveFile(root, filename) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    throw new RuntimeError("PROJECT_ROOT_INVALID", "Content Root cannot be enumerated.");
  }
  const found = entries.find((entry) => entry.name.toLowerCase() === filename.toLowerCase());
  return found ? path.join(root, found.name) : null;
}

async function readJsonFile(filePath, errorCode) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new RuntimeError(errorCode, "Project metadata is not valid JSON.");
  }
}

function parseEntryDocument(text, entryPath) {
  if (!/^\s*<!doctype\s+html\b/i.test(text) || !/<meta\b[^>]*charset\s*=\s*["']?utf-8\b/i.test(text)) {
    throw new RuntimeError("PROJECT_ENTRY_INVALID", "Entry Document must declare HTML document mode and UTF-8.");
  }
  const bodyStart = text.search(/<body\b[^>]*>/i);
  const bodyEnd = text.search(/<\/body\s*>/i);
  if (bodyStart < 0 || bodyEnd < bodyStart) throw new RuntimeError("PROJECT_ENTRY_INVALID", "Entry Document must contain a body.");

  const slides = [];
  const elements = [];
  const slideIds = new Set();
  const elementIds = new Set();
  const stack = [];
  const tagPattern = /<!--[^]*?-->|<\/?[A-Za-z][^>]*>/g;
  let match;
  while ((match = tagPattern.exec(text))) {
    const raw = match[0];
    if (raw.startsWith("<!--") || /^<!/i.test(raw)) continue;
    const closing = /^<\//.test(raw);
    const nameMatch = raw.match(/^<\/?([A-Za-z][A-Za-z0-9:-]*)/);
    if (!nameMatch) continue;
    const tagName = nameMatch[1].toLowerCase();
    if (closing) {
      const index = stack.map((item) => item.tagName).lastIndexOf(tagName);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const attrs = parseAttributes(raw);
    const inBody = match.index > bodyStart && match.index < bodyEnd;
    const slideId = attrs.get("data-od-slide");
    const stableId = attrs.get("data-od-id");
    if (slideId !== undefined) {
      if (!inBody || ["script", "style", "template"].includes(tagName) || !TOKEN_PATTERN.test(slideId) || slideIds.has(slideId)) {
        throw new RuntimeError("DECK_SLIDE_INVALID", "Slide roots must have unique valid IDs inside body.");
      }
      if (stack.some((item) => item.slideId)) throw new RuntimeError("DECK_SLIDE_INVALID", "Slide roots cannot be nested.");
      slideIds.add(slideId);
      slides.push({ slideId, slideIndex: slides.length, label: attrs.get("data-screen-label") || `Slide ${slides.length + 1}`, sourcePath: entryPath, stableElementIds: [] });
    }
    const activeSlide = [...stack].reverse().find((item) => item.slideId)?.slideId ?? slideId;
    if (stableId !== undefined) {
      if (!activeSlide || ["script", "style", "template"].includes(tagName) || !TOKEN_PATTERN.test(stableId) || elementIds.has(stableId)) {
        throw new RuntimeError("DECK_ELEMENT_ID_INVALID", "Stable Element IDs must be unique valid IDs inside a Slide.");
      }
      elementIds.add(stableId);
      const slide = slides.find((item) => item.slideId === activeSlide);
      slide.stableElementIds.push(stableId);
      elements.push({ stableElementId: stableId, slideId: activeSlide });
    }
    const selfClosing = /\/\s*>$/.test(raw) || VOID_ELEMENTS.has(tagName);
    if (!selfClosing) stack.push({ tagName, slideId: slideId ?? null });
  }
  if (slides.length === 0) throw new RuntimeError("DECK_NO_SLIDES", "Entry Document does not contain a Slide.");
  return { slides, elements };
}

function parseAttributes(tag) {
  const attrs = new Map();
  const body = tag.replace(/^<\/?[A-Za-z][A-Za-z0-9:-]*/, "").replace(/\/?>$/, "");
  const pattern = /([A-Za-z_:][A-Za-z0-9:_.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(body))) attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  return attrs;
}

function collectHtmlResources(text, fromPath) {
  const resources = [];
  const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/g;
  let match;
  while ((match = tagPattern.exec(text))) {
    const tagName = match[1].toLowerCase();
    const attrs = parseAttributes(match[0]);
    for (const attr of ["src", "poster"]) if (attrs.has(attr)) resources.push({ raw: attrs.get(attr), fromPath });
    if (tagName === "link" && attrs.has("href")) resources.push({ raw: attrs.get("href"), fromPath });
    if (attrs.has("srcset")) {
      for (const candidate of attrs.get("srcset").split(",")) resources.push({ raw: candidate.trim().split(/\s+/)[0], fromPath });
    }
    if (attrs.has("style")) resources.push(...collectCssResources(attrs.get("style"), fromPath));
  }
  return resources;
}

function collectCssResources(text, fromPath) {
  const resources = [];
  const pattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  let match;
  while ((match = pattern.exec(text))) resources.push({ raw: match[2].trim(), fromPath });
  const importPattern = /@import\s+(["'])(.*?)\1/gi;
  while ((match = importPattern.exec(text))) resources.push({ raw: match[2].trim(), fromPath });
  return resources;
}

function collectScriptResources(text, fromPath) {
  if (/\bfetch\s*\(|\bimport\s*\(|\bnavigator\.serviceWorker\b|\bURL\.createObjectURL\s*\(/.test(text)) {
    throw new RuntimeError("PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED", "Preview depends on a runtime-determined Resource URL.");
  }
  const resources = [];
  const patterns = [
    /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\sfrom\s+["']([^"']+)["']/g,
    /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) resources.push({ raw: match[1], fromPath });
  }
  return resources;
}

function validateResourceReference(raw, fromPath) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  if (value.startsWith("#") || value.startsWith("data:")) return null;
  if (value.startsWith("blob:")) throw new RuntimeError("PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED", "Blob Resources are not stable Project Resources.");
  if (/^(?:https?|file|javascript|vbscript):/i.test(value) || value.startsWith("//")) {
    throw new RuntimeError("PROJECT_RESOURCE_INVALID", "Remote and executable Resource URLs are not supported.");
  }
  const withoutQuery = value.split("#", 1)[0].split("?", 1)[0];
  if (!withoutQuery) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    throw new RuntimeError("PROJECT_RESOURCE_INVALID", "Resource path encoding is invalid.");
  }
  if (decoded.includes("\\") || decoded.includes("\0")) throw new RuntimeError("PROJECT_PATH_ESCAPE", "Resource path contains an invalid separator.");
  const baseParts = fromPath.split("/");
  baseParts.pop();
  const inputParts = decoded.startsWith("/") ? decoded.slice(1).split("/") : [...baseParts, ...decoded.split("/")];
  const resolved = [];
  for (const part of inputParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) throw new RuntimeError("PROJECT_PATH_ESCAPE", "Resource path escapes the Content Root.");
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  if (resolved.length === 0) throw new RuntimeError("PROJECT_RESOURCE_INVALID", "Resource path is empty.");
  return validateProjectRelativePath(resolved.join("/"), "PROJECT_PATH_ESCAPE");
}

function toProjectPath(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new RuntimeError("PROJECT_PATH_ESCAPE", "A Project path escapes the Content Root.");
  return validateProjectRelativePath(relative.split(path.sep).join("/"), "PROJECT_PATH_ESCAPE");
}

function kindForPath(projectPath) {
  const extension = path.posix.extname(projectPath).toLowerCase();
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (extension === ".css") return "css";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "script";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif"].includes(extension)) return "image";
  if ([".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg"].includes(extension)) return "media";
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension)) return "font";
  return "other";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
