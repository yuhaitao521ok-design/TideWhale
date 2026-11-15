import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(
  new URL("../scripts/cf-preview-assets.mjs", import.meta.url),
);

function runScript(
  cwd: string,
  env: Partial<
    Pick<NodeJS.ProcessEnv, "WORKERS_CI" | "WORKERS_CI_BRANCH" | "PRODUCTION_BRANCH">
  > = {},
) {
  const childEnv = { ...process.env };
  delete childEnv.WORKERS_CI;
  delete childEnv.WORKERS_CI_BRANCH;
  delete childEnv.PRODUCTION_BRANCH;

  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env: { ...childEnv, ...env },
    encoding: "utf8",
  });
}

function createAssetsDir(root: string) {
  const assetsDir = join(root, ".open-next", "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "_headers"), "header rules");
  writeFileSync(join(assetsDir, "_redirects"), "redirect rules");
  return assetsDir;
}

test("removes routing files from preview assets", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-preview-assets-"));
  try {
    const assetsDir = createAssetsDir(root);
    const result = runScript(root, {
      WORKERS_CI: "1",
      WORKERS_CI_BRANCH: "feature/preview",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(assetsDir, "_headers")), false);
    assert.equal(existsSync(join(assetsDir, "_redirects")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly when Workers CI has no branch name", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-preview-assets-"));
  try {
    const result = runScript(root, { WORKERS_CI: "1" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WORKERS_CI_BRANCH is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing preview assets directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-preview-assets-"));
  try {
    const result = runScript(root, {
      WORKERS_CI: "1",
      WORKERS_CI_BRANCH: "feature/preview",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.open-next\/assets 不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves routing files on the production branch", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-preview-assets-"));
  try {
    const assetsDir = createAssetsDir(root);
    const result = runScript(root, {
      WORKERS_CI: "1",
      WORKERS_CI_BRANCH: "main",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(assetsDir, "_headers"), "utf8"), "header rules");
    assert.equal(readFileSync(join(assetsDir, "_redirects"), "utf8"), "redirect rules");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
