import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRendererHtml } from "../src/bridge.mjs";
import { canonicalizeContentRoot, publicSnapshot, scanProject } from "../src/project.mjs";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("PROJECT-01 creates an immutable snapshot and changes its version only for content changes", async () => {
  const root = await createBasicProject();
  try {
    const first = await scanProject({ contentRoot: root, projectId: PROJECT_ID });
    assert.equal(first.entryPath, "index.html");
    assert.deepEqual(first.slides.map((slide) => slide.slideId), ["cover", "detail"]);
    assert.deepEqual(first.files.map((file) => file.path), ["index.html", "styles/deck.css"]);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.files), true);
    assert.equal(Object.isFrozen(first.files[0]), true);
    assert.doesNotMatch(JSON.stringify(publicSnapshot(first)).replace(/\\/g, "/"), /[A-Za-z]:\/|\/\/server/i);

    const originalVersion = first.fileIndexVersion;
    await fs.utimes(path.join(root, "styles", "deck.css"), new Date("2024-01-01"), new Date("2024-01-02"));
    const sameContent = await scanProject({ contentRoot: root, projectId: PROJECT_ID });
    assert.equal(sameContent.fileIndexVersion, originalVersion);

    await fs.appendFile(path.join(root, "styles", "deck.css"), "\n.detail { color: #123456; }\n");
    const changedContent = await scanProject({ contentRoot: root, projectId: PROJECT_ID });
    assert.notEqual(changedContent.fileIndexVersion, originalVersion);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PROJECT-02 uses a manifest entry deterministically and never falls back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-manifest-contract-"));
  try {
    await fs.mkdir(path.join(root, "deck"));
    await fs.writeFile(path.join(root, "index.html"), minimalHtml("fallback"));
    await fs.writeFile(path.join(root, "deck", "main.htm"), minimalHtml("manifest"));
    await fs.writeFile(path.join(root, "shppt.json"), JSON.stringify({ schemaVersion: 1, entry: "deck/main.htm" }));
    const snapshot = await scanProject({ contentRoot: root, projectId: PROJECT_ID });
    assert.equal(snapshot.entryPath, "deck/main.htm");

    await fs.writeFile(path.join(root, "shppt.json"), JSON.stringify({ schemaVersion: 1, entry: "missing.html" }));
    await assert.rejects(scanProject({ contentRoot: root, projectId: PROJECT_ID }), (error) => error.code === "PROJECT_ENTRY_NOT_FOUND");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PROJECT-03 rejects unsafe or incomplete Deck inputs", async (t) => {
  const cases = [
    ["protected Resource", (root) => appendCss(root, ".protected { background: url(../.git/config); }"), "PROJECT_PROTECTED_PATH"],
    ["missing Resource", (root) => appendCss(root, ".missing { background: url(../missing.png); }"), "PROJECT_RESOURCE_INVALID"],
    ["remote Resource", (root) => appendCss(root, ".remote { background: url(https://example.invalid/a.png); }"), "PROJECT_RESOURCE_INVALID"],
    ["dynamic Resource", (root) => appendHtml(root, "<script>fetch('missing.json')</script>"), "PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED"],
    ["dynamic element Resource", (root) => appendHtml(root, "<script>document.body.setAttribute('src', 'missing.json')</script>"), "PROJECT_RESOURCE_DYNAMIC_UNSUPPORTED"],
    ["invalid Slide ID", (root) => replaceHtml(root, "data-od-slide=\"cover\"", "data-od-slide=\"1-cover\""), "DECK_SLIDE_INVALID"],
    ["duplicate Stable Element ID", (root) => appendHtml(root, "<p data-od-id=\"cover-title\">duplicate</p>"), "DECK_ELEMENT_ID_INVALID"]
  ];

  for (const [label, mutate, expectedCode] of cases) {
    await t.test(label, async () => {
      const root = await createBasicProject();
      try {
        await mutate(root);
        await assert.rejects(scanProject({ contentRoot: root, projectId: PROJECT_ID }), (error) => error.code === expectedCode);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("PROJECT-04 rejects UNC Content Roots before scanning", async () => {
  await assert.rejects(canonicalizeContentRoot("\\\\server\\share"), (error) => error.code === "PROJECT_ROOT_INVALID");
});

test("PROJECT-04 rejects a reparse-point Content Root", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-root-reparse-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-root-target-"));
  const link = path.join(parent, "link");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(canonicalizeContentRoot(link), (error) => error.code === "PROJECT_PATH_ESCAPE");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("PROJECT-05 indexes static ESM and import.meta URL resources", async () => {
  const root = await createBasicProject();
  try {
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts", "main.js"), `import "./module.js";\nconst mark = new URL("../styles/deck.css", import.meta.url);\nvoid mark;\n`);
    await fs.writeFile(path.join(root, "scripts", "module.js"), "export const loaded = true;\n");
    await appendHtml(root, "<script type=\"module\" src=\"scripts/main.js\"></script>");
    const snapshot = await scanProject({ contentRoot: root, projectId: PROJECT_ID });
    assert.deepEqual(snapshot.files.filter((file) => file.kind === "script").map((file) => file.path), ["scripts/main.js", "scripts/module.js"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PREVIEW-01 exposes loading/ready/error state and Slide ID navigation", () => {
  const html = createRendererHtml({
    protocol: "shppt-bridge",
    version: 1,
    projectId: PROJECT_ID,
    fileIndexVersion: "sha256:version",
    previewSessionId: "session",
    iframeInstanceId: "iframe",
    scopeId: "scope",
    bridgeNonce: "nonce",
    slideId: "cover",
    expectedSlideIds: ["cover", "detail"],
    entryUrl: "/preview/scope/index.html",
    origin: "http://127.0.0.1:1234"
  });
  assert.match(html, /data-state="loading"/);
  assert.match(html, /setState\("error"/);
  assert.match(html, /setState\("ready"/);
  assert.match(html, /__shpptSelectSlide/);
  assert.match(html, /od:bridge:activate-slide/);
});

async function createBasicProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-project-contract-"));
  await fs.mkdir(path.join(root, "styles"));
  await fs.writeFile(path.join(root, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/deck.css"></head>
<body><main>
  <section data-od-slide="cover" data-screen-label="Cover"><h1 data-od-id="cover-title">Cover</h1></section>
  <section data-od-slide="detail"><p data-od-id="detail-copy">Detail</p></section>
</main></body></html>
`);
  await fs.writeFile(path.join(root, "styles", "deck.css"), ".slide { width: 100vw; height: 100vh; }\n");
  return root;
}

async function appendCss(root, text) {
  await fs.appendFile(path.join(root, "styles", "deck.css"), `\n${text}\n`);
}

async function appendHtml(root, text) {
  const htmlPath = path.join(root, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  await fs.writeFile(htmlPath, html.replace("</body>", `${text}</body>`));
}

async function replaceHtml(root, oldText, newText) {
  const htmlPath = path.join(root, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  await fs.writeFile(htmlPath, html.replace(oldText, newText));
}

function minimalHtml(slideId) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><section data-od-slide="${slideId}"><h1 data-od-id="title">${slideId}</h1></section></body></html>`;
}
