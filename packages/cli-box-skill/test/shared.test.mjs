import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_IDS,
  HARNESS_TARGETS,
  parseTargets,
  detectHarnesses,
  installSkillToTargets,
} from "../installer/shared.mjs";

test("HARNESS_IDS lists the three harnesses", () => {
  assert.deepEqual([...HARNESS_IDS].sort(), ["claude", "openclaw", "opencode"]);
});

test("HARNESS_TARGETS has label + skillDir for each", () => {
  for (const id of HARNESS_IDS) {
    assert.ok(HARNESS_TARGETS[id].label, `${id} has label`);
    const dir = HARNESS_TARGETS[id].skillDir("/h");
    assert.ok(dir.startsWith("/h"), `${id} skillDir under home`);
  }
});

test("parseTargets: explicit ids", () => {
  assert.deepEqual(parseTargets(["claude", "opencode"]), ["claude", "opencode"]);
});

test("parseTargets: 'all' expands to every harness", () => {
  assert.deepEqual(parseTargets(["all"]).sort(), [...HARNESS_IDS].sort());
});

test("parseTargets: comma/space string normalizes", () => {
  assert.deepEqual(parseTargets("claude, opencode"), ["claude", "opencode"]);
  assert.deepEqual(parseTargets("openclaw"), ["openclaw"]);
});

test("parseTargets: empty input returns []", () => {
  assert.deepEqual(parseTargets([]), []);
  assert.deepEqual(parseTargets(""), []);
});

test("parseTargets: unknown id throws listing valid targets", () => {
  assert.throws(() => parseTargets(["foo"]), /Unknown target.*claude.*openclaw.*opencode.*all/s);
});

test("detectHarnesses: only dirs that exist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-detect-"));
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const found = detectHarnesses(home);
    assert.ok(found.includes("claude"));
    assert.ok(!found.includes("opencode"));
    assert.ok(!found.includes("openclaw"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installSkillToTargets: writes SKILL.md into each target dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-install-"));
  try {
    const results = installSkillToTargets(["claude", "openclaw"], {
      home,
      content: "---\nname: cli-box\ndescription: x\n---\nbody",
    });
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));
    assert.ok(
      fs.existsSync(path.join(home, ".claude", "skills", "cli-box", "SKILL.md"))
    );
    assert.ok(
      fs.existsSync(path.join(home, ".openclaw", "skills", "cli-box", "SKILL.md"))
    );
    assert.ok(
      !fs.existsSync(path.join(home, ".config", "opencode", "skills", "cli-box"))
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("per-target SKILL.md customization", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "cli-box-skill-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("openclaw body documents /tmp/openclaw screenshot path", () => {
    const results = installSkillToTargets(["openclaw"], { home });
    const body = readFileSync(
      path.join(home, ".openclaw", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(results[0].ok, "install should succeed");
    assert.ok(body.includes("/tmp/openclaw/"), "should mention /tmp/openclaw/");
    assert.ok(/screenshot.*\/tmp\/openclaw/s.test(body), "should tie screenshots to the path");
  });

  test("claude body does NOT mention /tmp/openclaw", () => {
    installSkillToTargets(["claude"], { home });
    const body = readFileSync(
      path.join(home, ".claude", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(!body.includes("/tmp/openclaw/"), "claude body must stay generic");
  });

  test("opencode body does NOT mention /tmp/openclaw", () => {
    installSkillToTargets(["opencode"], { home });
    const body = readFileSync(
      path.join(home, ".config", "opencode", "skills", "cli-box", "SKILL.md"),
      "utf8"
    );
    assert.ok(!body.includes("/tmp/openclaw/"), "opencode body must stay generic");
  });
});
