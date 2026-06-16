// Integration tests that spawn the real CLI. Requires commander + @clack/prompts
// installed (Task 2). Spawning => stdin is not a TTY, so the interactive branch
// is not exercised here (it is covered by manual release testing).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../installer/cli.mjs");

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-cli-"));
}

test("install claude writes SKILL.md only to Claude dir", () => {
  const home = tmpHome();
  try {
    const r = run(["install", "claude"], home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      fs.existsSync(path.join(home, ".claude", "skills", "cli-box", "SKILL.md"))
    );
    assert.ok(
      !fs.existsSync(path.join(home, ".config", "opencode", "skills", "cli-box"))
    );
    assert.ok(
      !fs.existsSync(path.join(home, ".openclaw", "skills", "cli-box"))
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install all writes SKILL.md to all three harnesses", () => {
  const home = tmpHome();
  try {
    const r = run(["install", "all"], home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const sub of [".claude", ".config/opencode", ".openclaw"]) {
      assert.ok(
        fs.existsSync(path.join(home, sub, "skills", "cli-box", "SKILL.md")),
        `missing ${sub}`
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install with no target in non-TTY exits 1 with guidance", () => {
  const home = tmpHome();
  try {
    const r = run(["install"], home);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /Specify targets/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install with unknown target exits non-zero", () => {
  const home = tmpHome();
  try {
    const r = run(["install", "bogus"], home);
    assert.notEqual(r.status, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install --no-tui with no target exits 1", () => {
  const home = tmpHome();
  try {
    const r = run(["install", "--no-tui"], home);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /Specify targets/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("install --no-tui claude succeeds", () => {
  const home = tmpHome();
  try {
    const r = run(["install", "--no-tui", "claude"], home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      fs.existsSync(path.join(home, ".claude", "skills", "cli-box", "SKILL.md"))
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
