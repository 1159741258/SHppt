import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadOrCreateProjectId, publicSnapshot, scanProject } from "../src/project.mjs";

const fixtureRoot = path.resolve("tests/fixtures/p0-deck");

test("HTML-01 indexes the fixed Project without exposing the Content Root", async () => {
  const snapshot = await scanProject({ contentRoot: fixtureRoot, projectId: "11111111-1111-4111-8111-111111111111" });
  const visible = publicSnapshot(snapshot);
  assert.equal(visible.type, "html-deck");
  assert.equal(visible.entryPath, "index.html");
  assert.deepEqual(visible.slides.map((slide) => slide.slideId), ["cover", "detail"]);
  assert.deepEqual(visible.files.map((file) => file.path), [
    "assets/fixture-font.woff2",
    "assets/fixture-mark.svg",
    "index.html",
    "shppt.json",
    "styles/deck.css"
  ]);
  assert.equal(visible.files.find((file) => file.kind === "font")?.path, "assets/fixture-font.woff2");
  assert.doesNotMatch(JSON.stringify(visible), /[A-Za-z]:\\|\\\\/);
  assert.equal("contentRoot" in visible, false);
});

test("HTML-02 reuses a Project identity for the same canonical Content Root", async () => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-project-state-"));
  try {
    const first = await loadOrCreateProjectId(stateDirectory, await fs.realpath(fixtureRoot));
    const second = await loadOrCreateProjectId(stateDirectory, path.join(fixtureRoot, "."));
    assert.equal(first, second);
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test("HTML-03 does not fall back when the manifest entry is missing", async () => {
  const root = await copyFixture();
  try {
    await fs.writeFile(path.join(root, "shppt.json"), JSON.stringify({ schemaVersion: 1, entry: "missing.html" }));
    await assert.rejects(
      scanProject({ contentRoot: root, projectId: "22222222-2222-4222-8222-222222222222" }),
      (error) => error.code === "PROJECT_ENTRY_NOT_FOUND"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTML-03 reports a manifest Content Root escape as a path error", async () => {
  const root = await copyFixture();
  try {
    await fs.writeFile(path.join(root, "shppt.json"), JSON.stringify({ schemaVersion: 1, entry: "../index.html" }));
    await assert.rejects(
      scanProject({ contentRoot: root, projectId: "44444444-4444-4444-8444-444444444444" }),
      (error) => error.code === "PROJECT_PATH_ESCAPE"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTML-06 rejects remote Resource dependencies", async () => {
  const root = await copyFixture();
  try {
    const cssPath = path.join(root, "styles", "deck.css");
    const css = await fs.readFile(cssPath, "utf8");
    await fs.writeFile(cssPath, `${css}\n.remote { background-image: url(https://example.invalid/image.png); }\n`);
    await assert.rejects(
      scanProject({ contentRoot: root, projectId: "33333333-3333-4333-8333-333333333333" }),
      (error) => error.code === "PROJECT_RESOURCE_INVALID"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function copyFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shppt-project-fixture-"));
  await fs.cp(fixtureRoot, root, { recursive: true });
  return root;
}
