# cli-box-skill Interactive Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `cli-box-skill install` command (mirroring `oh-my-openagent`) that lets users pick Claude Code / OpenCode / OpenClaw, with a slim non-interactive `postinstall`, an arg-driven `install.sh`, and agent-friendly READMEs.

**Architecture:** Pure logic lives in a zero-dependency `installer/shared.mjs` (unit-tested with Node's built-in `node:test`). The CLI entry `installer/cli.mjs` adds `commander` + `@clack/prompts` on top. `postinstall.mjs` and `install.sh` are slimmed: binaries only + guidance; skill placement is the user's explicit choice.

**Tech Stack:** Node.js (ESM), `commander`, `@clack/prompts`, `node:test`, bash (`install.sh`).

**Spec:** `docs/superpowers/specs/2026-06-16-installer-ux-design.md`

**Branch:** `feat/cli-box-skill-installer-0.2.7` (already created; spec committed).

---

## File Structure

| File | Status | Responsibility |
|:---|:---|:---|
| `packages/cli-box-skill/installer/shared.mjs` | Create | Zero-dep pure logic: `HARNESS_TARGETS`, `parseTargets`, `detectHarnesses`, `installSkillToTargets`, `ensureBinaries`, `readBundledSkill` |
| `packages/cli-box-skill/installer/cli.mjs` | Create | CLI entry: `commander` + `@clack/prompts`; orchestrate resolve → install |
| `packages/cli-box-skill/test/shared.test.mjs` | Create | `node:test` unit tests for `shared.mjs` (zero-dep, runs without `npm install`) |
| `packages/cli-box-skill/test/cli.test.mjs` | Create | `node:test` integration: spawns `cli.mjs` for non-interactive paths (needs deps) |
| `packages/cli-box-skill/postinstall.mjs` | Modify | Slim: `ensureBinaries()` + guidance; remove skill copy |
| `packages/cli-box-skill/package.json` | Modify | Add `cli-box-skill` bin, `installer/` to files, `commander`+`@clack/prompts` deps, `test` script |
| `packages/cli-box-skill/skill/install.sh` | Modify | Accept target arg (positional/env); hint+exit if none |
| `packages/cli-box-skill/skill/SKILL.md` | Modify | Installation section → `npx cli-box-skill install` |
| `README.md`, `README.zh-cn.md`, `packages/cli-box-skill/README.md` | Modify | Agent sentence + human one-liner + curl-with-target |
| `docs/guide/installation.md` | Modify | Option A/B align with new commands |
| `tests/e2e-skill-install.sh` | Modify | postinstall no longer copies skill; add install.sh target tests |
| `test.sh` | Modify | Add "Skill Package Tests" section (node:test, deps via npm install) |
| `Cargo.toml`, `electron-app/package.json`, `release.sh` | Modify | Bump 0.2.6 → 0.2.7 |
| `release/release-pipeline.md` | Modify | Note the installer command + postinstall no longer copies skill |

> **Git quirk note:** Earlier work showed `git add` (without `-f`) refuses new paths under `packages/cli-box-skill/bin/` even though the dir is tracked. The new files live in `installer/` (not `bin/`) to avoid this. If any `git add` of a new file is refused, use `git add -f`.

---

## Task 1: Pure logic module `shared.mjs` + unit tests (TDD)

**Files:**
- Create: `packages/cli-box-skill/installer/shared.mjs`
- Create: `packages/cli-box-skill/test/shared.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli-box-skill/test/shared.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/cli-box-skill/test/shared.test.mjs`
Expected: FAIL — `Cannot find module '.../installer/shared.mjs'`.

- [ ] **Step 3: Implement `shared.mjs`**

Create `packages/cli-box-skill/installer/shared.mjs`:

```js
// Pure logic for the cli-box skill installer. Zero external dependencies
// (node: builtins only) so it can be unit-tested without `npm install`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function hasBinary(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const candidate =
    process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  return dirs.some((d) => candidate.some((c) => safeExists(path.join(d, c))));
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export const HARNESS_TARGETS = {
  claude: {
    label: "Claude Code",
    skillDir: (home) => path.join(home, ".claude", "skills", "cli-box"),
    detect: (home) => safeExists(path.join(home, ".claude")) || hasBinary("claude"),
  },
  opencode: {
    label: "OpenCode",
    skillDir: (home) =>
      path.join(home, ".config", "opencode", "skills", "cli-box"),
    detect: (home) =>
      safeExists(path.join(home, ".config", "opencode")) || hasBinary("opencode"),
  },
  openclaw: {
    label: "OpenClaw",
    skillDir: (home) => path.join(home, ".openclaw", "skills", "cli-box"),
    detect: (home) =>
      safeExists(path.join(home, ".openclaw")) || hasBinary("openclaw"),
  },
};

export const HARNESS_IDS = Object.keys(HARNESS_TARGETS);

// Accepts an array of tokens or a comma/space-separated string.
// Returns the resolved list of harness ids. Throws on unknown tokens.
export function parseTargets(input) {
  const arr = Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/);
  const tokens = arr.map((t) => String(t).trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.includes("all")) return [...HARNESS_IDS];
  const invalid = tokens.filter((t) => !HARNESS_IDS.includes(t));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown target(s): ${invalid.join(", ")}. Valid: ${[...HARNESS_IDS, "all"].join(", ")}`
    );
  }
  return Array.from(new Set(tokens));
}

export function detectHarnesses(home = os.homedir()) {
  return HARNESS_IDS.filter((id) => HARNESS_TARGETS[id].detect(home));
}

export function readBundledSkill() {
  return fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
}

// Writes the skill body into each target dir. Returns [{id, dir, ok, error?}].
export function installSkillToTargets(ids, { home = os.homedir(), content } = {}) {
  const body = content ?? readBundledSkill();
  return ids.map((id) => {
    const dir = HARNESS_TARGETS[id].skillDir(home);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), body);
      return { id, dir, ok: true };
    } catch (e) {
      return { id, dir, ok: false, error: e.message };
    }
  });
}

// Symlinks the platform-package binaries into ~/.cli-box/bin.
// Never throws: returns { ok:false, reason } if the platform package is absent.
export function ensureBinaries({ home = os.homedir() } = {}) {
  const binDir = path.join(home, ".cli-box", "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const pkgName = `cli-box-${platform}-${arch}`;

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(`${pkgName}/package.json`));
  } catch {
    return { ok: false, reason: `platform package ${pkgName} not found`, binDir };
  }

  const linked = [];
  for (const bin of ["cli-box", "cli-box-daemon"]) {
    const src = path.join(pkgDir, "bin", bin);
    const dst = path.join(binDir, bin);
    if (safeExists(src)) {
      try {
        fs.rmSync(dst, { force: true });
        fs.symlinkSync(src, dst);
        fs.chmodSync(src, 0o755);
        linked.push(bin);
      } catch {
        /* ignore individual link failures */
      }
    }
  }
  return { ok: true, linked, binDir };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/cli-box-skill/test/shared.test.mjs`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli-box-skill/installer/shared.mjs packages/cli-box-skill/test/shared.test.mjs
git commit -m "feat(skill): add zero-dep installer shared logic + tests"
```

---

## Task 2: Add installer dependencies to the skill package

**Files:**
- Modify: `packages/cli-box-skill/package.json`

- [ ] **Step 1: Install commander and @clack/prompts**

Run:
```bash
cd packages/cli-box-skill && npm install commander @clack/prompts && cd -
```
This adds `dependencies` (with the latest compatible versions) to `package.json`. Confirm with:
```bash
node -e "const p=require('./packages/cli-box-skill/package.json'); console.log(JSON.stringify(p.dependencies))"
```
Expected: a JSON object containing `commander` and `@clack/prompts`.

- [ ] **Step 2: Add the `cli-box-skill` bin, `test` script, and `installer/` to files**

Edit `packages/cli-box-skill/package.json`. Update these three fields (keep all other fields unchanged; the exact dependency versions are whatever Step 1 wrote — do not revert them):

```json
"main": "postinstall.mjs",
"bin": {
  "cli-box": "./bin/cli-box-wrapper.js",
  "cli-box-skill": "./installer/cli.mjs"
},
"scripts": {
  "postinstall": "node postinstall.mjs",
  "test": "node --test test/"
},
"dependencies": {
  "@clack/prompts": "<version from Step 1>",
  "commander": "<version from Step 1>"
},
"files": [
  "skill/SKILL.md",
  "skill/install.sh",
  "postinstall.mjs",
  "bin/",
  "installer/",
  "README.md"
],
```

> Do NOT add `test/` to `files` — test files must not ship to npm.

- [ ] **Step 3: Verify the package still parses**

Run: `node -e "console.log(require('./packages/cli-box-skill/package.json').bin)"`
Expected: `{ 'cli-box': './bin/cli-box-wrapper.js', 'cli-box-skill': './installer/cli.mjs' }`

- [ ] **Step 4: Commit**

```bash
git add packages/cli-box-skill/package.json packages/cli-box-skill/package-lock.json
git commit -m "chore(skill): add commander + @clack deps, cli-box-skill bin, installer/ files"
```

> If `package-lock.json` was not created (no prior lockfile) that's fine — add it if present.

---

## Task 3: CLI entry `cli.mjs` + integration tests (TDD)

**Files:**
- Create: `packages/cli-box-skill/test/cli.test.mjs`
- Create: `packages/cli-box-skill/installer/cli.mjs`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/cli-box-skill/test/cli.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli-box-skill && npm test -- cli.test.mjs 2>&1 || node --test test/cli.test.mjs; cd -`
(simpler:) `cd packages/cli-box-skill && node --test test/cli.test.mjs; cd -`
Expected: FAIL — `Cannot find module '.../installer/cli.mjs'` or non-zero exits.

- [ ] **Step 3: Implement `cli.mjs`**

Create `packages/cli-box-skill/installer/cli.mjs`:

```js
#!/usr/bin/env node
// cli-box-skill — installer for the cli-box skill into agent harnesses.
// Usage:
//   npx cli-box-skill install              # interactive (TTY)
//   cli-box-skill install claude opencode  # explicit
//   cli-box-skill install all              # all harnesses
//   cli-box-skill install --no-tui claude  # non-interactive explicit
import { Command } from "commander";
import * as clack from "@clack/prompts";
import {
  HARNESS_IDS,
  HARNESS_TARGETS,
  parseTargets,
  detectHarnesses,
  installSkillToTargets,
  ensureBinaries,
} from "./shared.mjs";

const isTTY = Boolean(process.stdin.isTTY);

async function interactiveSelect() {
  const detected = detectHarnesses();
  const options = HARNESS_IDS.map((id) => ({
    value: id,
    label: `${HARNESS_TARGETS[id].label}  ${detected.includes(id) ? "(detected)" : ""}`.trim(),
    hint: id,
  }));
  const selected = await clack.multiselect({
    message: "Where should the cli-box skill be installed?",
    options,
    initialValues: detected,
    required: false,
  });
  if (clack.isCancel(selected)) {
    console.log("Cancelled.");
    process.exit(0);
  }
  return selected;
}

function failNoTarget() {
  console.error(
    `Non-interactive shell. Specify targets:\n  cli-box-skill install <${[
      ...HARNESS_IDS,
      "all",
    ].join("|")}>`
  );
  process.exit(1);
}

async function runInstall(targets, opts) {
  const bin = ensureBinaries();
  if (bin.ok) {
    for (const b of bin.linked) console.log(`  ✓ ${b} → ~/.cli-box/bin/${b}`);
  } else {
    console.warn(`  ⚠ ${bin.reason} (binaries may be missing)`);
  }

  let ids;
  if (targets.length > 0) {
    ids = parseTargets(targets);
  } else if (opts.tui && isTTY) {
    ids = await interactiveSelect();
    if (ids.length === 0) {
      console.log("No target selected — nothing to do.");
      process.exit(0);
    }
  } else {
    return failNoTarget();
  }

  const results = installSkillToTargets(ids);
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${HARNESS_TARGETS[r.id].label} → ${r.dir}/SKILL.md`);
    else console.error(`  ✗ ${HARNESS_TARGETS[r.id].label}: ${r.error}`);
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nInstalled the cli-box skill into ${okCount}/${results.length} harness(es).`);
  process.exit(okCount > 0 ? 0 : 1);
}

const program = new Command();
program
  .name("cli-box-skill")
  .description("Install the cli-box skill into agent harnesses (Claude Code / OpenCode / OpenClaw)");

program
  .command("install", { isDefault: true })
  .description("Install the cli-box skill into one or more agent harnesses")
  .argument("[targets...]", "claude | opencode | openclaw | all")
  .option("--no-tui", "Non-interactive (targets required)")
  .action(async (targets, opts) => {
    try {
      await runInstall(targets, opts);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli-box-skill && node --test test/cli.test.mjs; cd -`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Sanity-run the CLI manually**

Run: `HOME=$(mktemp -d) node packages/cli-box-skill/installer/cli.mjs install claude && echo OK`
Expected: prints `✓ Claude Code → <tmp>/.claude/skills/cli-box/SKILL.md` and a summary, then `OK`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli-box-skill/installer/cli.mjs packages/cli-box-skill/test/cli.test.mjs
git commit -m "feat(skill): add cli-box-skill install command (commander + @clack)"
```

---

## Task 4: Slim `postinstall.mjs`

**Files:**
- Modify: `packages/cli-box-skill/postinstall.mjs`

- [ ] **Step 1: Replace the file contents**

Overwrite `packages/cli-box-skill/postinstall.mjs` with:

```js
#!/usr/bin/env node
// postinstall.mjs — runs after `npm install -g cli-box-skill`.
// Non-interactive: only symlinks the platform binaries and prints guidance.
// Skill placement into a harness is an explicit user choice:
//   npx cli-box-skill install
import { ensureBinaries } from "./installer/shared.mjs";

function ok(m) { console.log(`  ✓ ${m}`); }
function warn(m) { console.warn(`  ⚠ ${m}`); }

const bin = ensureBinaries();
if (bin.ok) {
  for (const b of bin.linked) ok(`${b} → ~/.cli-box/bin/${b}`);
} else {
  warn(bin.reason);
  warn("Binaries not set up. Re-run: npx cli-box-skill install");
}

console.log("");
console.log("  cli-box binaries are ready. To install the skill into your agent harness, run:");
console.log("    npx cli-box-skill install");
console.log("  (targets: claude | opencode | openclaw | all)");
console.log("");
```

- [ ] **Step 2: Verify postinstall is non-interactive and does not copy skills**

Run:
```bash
T=$(mktemp -d) && HOME=$T node packages/cli-box-skill/postinstall.mjs; echo "exit=$?"; ls -la "$T"; rm -rf "$T"
```
Expected: prints the guidance message, `exit=0`, and the temp HOME contains **no** `.claude/skills/cli-box` (skill is NOT copied by postinstall anymore).

- [ ] **Step 3: Commit**

```bash
git add packages/cli-box-skill/postinstall.mjs
git commit -m "refactor(skill): slim postinstall to binaries + guidance (no skill copy)"
```

---

## Task 5: `install.sh` target-arg support

**Files:**
- Modify: `packages/cli-box-skill/skill/install.sh`

- [ ] **Step 1: Update the header vars and add OpenClaw + target resolution**

In `packages/cli-box-skill/skill/install.sh`, find the existing dir vars block (around lines 9–11):

```bash
INSTALL_DIR="$HOME/.cli-box/bin"
SKILL_CLAUDE_DIR="$HOME/.claude/skills/cli-box"
SKILL_OPENCODE_DIR="$HOME/.config/opencode/skills/cli-box"
```

Replace it with:

```bash
INSTALL_DIR="$HOME/.cli-box/bin"
SKILL_CLAUDE_DIR="$HOME/.claude/skills/cli-box"
SKILL_OPENCODE_DIR="$HOME/.config/opencode/skills/cli-box"
SKILL_OPENCLAW_DIR="$HOME/.openclaw/skills/cli-box"
```

- [ ] **Step 2: Replace the skill-copy block with target-driven logic**

Find the current skill-copy block (the `# Install skill to Claude Code` … `ok "Skill installed to $SKILL_OPENCODE_DIR"` section, which after 0.2.6 installs unconditionally to both). Replace that whole block with:

```bash
# --- Resolve install targets ---
# Precedence: positional args > CLI_BOX_TARGETS env. Accept space- or comma-
# separated values; "all" expands to every harness.
if [ "$#" -gt 0 ]; then
  TARGETS_RAW="$*"
elif [ -n "${CLI_BOX_TARGETS:-}" ]; then
  TARGETS_RAW="$CLI_BOX_TARGETS"
else
  TARGETS_RAW=""
fi

# Normalize to lowercase, comma/space -> newline
TARGETS=$(echo "$TARGETS_RAW" | tr '[:upper:]' '[:lower:]' | tr ',[:space:]' '\n' | grep -v '^$' || true)

if [ -z "$TARGETS" ]; then
  echo ""
  err "No install target given."
  echo "  Usage: bash install.sh <claude|opencode|openclaw|all> [more...]"
  echo "     or: CLI_BOX_TARGETS=claude,opencode bash install.sh"
  exit 1
fi

install_skill_dir() {
  local label="$1" dir="$2"
  info "Installing skill to ${label}..."
  mkdir -p "$dir"
  cp "$TMPDIR/SKILL.md" "$dir/"
  ok "Skill installed to $dir"
}

echo "$TARGETS" | grep -qxE 'all' && TARGETS="claude
opencode
openclaw"

while IFS= read -r target; do
  case "$target" in
    claude)  install_skill_dir "Claude Code" "$SKILL_CLAUDE_DIR" ;;
    opencode) install_skill_dir "OpenCode"    "$SKILL_OPENCODE_DIR" ;;
    openclaw) install_skill_dir "OpenClaw"    "$SKILL_OPENCLAW_DIR" ;;
    *) err "Unknown target: $target (valid: claude | opencode | openclaw | all)"; exit 1 ;;
  esac
done <<< "$TARGETS"
```

- [ ] **Step 3: Verify install.sh with a target**

Run:
```bash
T=$(mktemp -d)
# point install.sh at a local tarball by stubbing the download (same technique the e2e test uses)
# Simpler smoke: just exercise the no-arg hint path:
HOME=$T bash packages/cli-box-skill/skill/install.sh 2>&1 | head -5; echo "exit=${PIPESTATUS[0]}"
rm -rf "$T"
```
Expected: prints `✗ No install target given.` + the usage lines, `exit=1`. (The full happy path with a real tarball download is covered by the e2e test in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add packages/cli-box-skill/skill/install.sh
git commit -m "feat(skill): install.sh takes a target arg; hint+exit when none"
```

---

## Task 6: Documentation — SKILL.md, READMEs, installation guide

**Files:**
- Modify: `packages/cli-box-skill/skill/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-cn.md`
- Modify: `packages/cli-box-skill/README.md`
- Modify: `docs/guide/installation.md`

- [ ] **Step 1: Update SKILL.md Installation section**

In `packages/cli-box-skill/skill/SKILL.md`, replace the `## Installation` block (the `npm install -g cli-box-skill` + curl lines) with:

```markdown
## Installation

```bash
npx cli-box-skill install
```

Choose Claude Code, OpenCode, and/or OpenClaw. Or non-interactively:

```bash
npx cli-box-skill install claude   # claude | opencode | openclaw | all
```
```

- [ ] **Step 2: Update the root `README.md` Installation section**

In `README.md`:
(a) In the TL;DR table, change the **npm** row to:

```
| **npm** | `npx cli-box-skill install` | Choose harness(es); binaries + skill installed |
```

and the **Shell** row to:

```
| **Shell** | `bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh) claude` | Downloads to `~/.cli-box/bin/`, installs skill |
```

(b) Replace the `### For LLM Agents` block with:

```markdown
### For LLM Agents

> **Install cli-box in one command:** run
> `npx cli-box-skill install all` to install the skill into every supported
> harness (Claude Code, OpenCode, OpenClaw), or replace `all` with `claude` /
> `opencode` / `openclaw` for a single target.

```bash
npx cli-box-skill install claude    # claude | opencode | openclaw | all
```
```

- [ ] **Step 3: Update `README.zh-cn.md` (Chinese mirror)**

Apply the same structural changes as Step 2, in Chinese. npm row:

```
| **npm** | `npx cli-box-skill install` | 选择 harness，自动装二进制 + skill |
```

Shell row:

```
| **Shell** | `bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh) claude` | 下载到 `~/.cli-box/bin/`，安装 skill |
```

Agent block:

```markdown
### 给 AI Agent

> **一行安装 cli-box：** 运行 `npx cli-box-skill install all` 把 skill 装到所有受支持的
> harness（Claude Code、OpenCode、OpenClaw）；把 `all` 换成 `claude` / `opencode` /
> `openclaw` 可只装一个。

```bash
npx cli-box-skill install claude    # claude | opencode | openclaw | all
```
```

- [ ] **Step 4: Update `packages/cli-box-skill/README.md`**

Replace the `## Install` block with:

```markdown
## Install

```bash
npx cli-box-skill install          # interactive: pick Claude Code / OpenCode / OpenClaw
npx cli-box-skill install claude   # non-interactive: claude | opencode | openclaw | all
```
```

And the `## No npm?` block with:

```markdown
## No npm?

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh) claude
```
```

- [ ] **Step 5: Update `docs/guide/installation.md`**

Replace Step 2's `### Option A` / `### Option B` with:

```markdown
### Option A: npm (recommended)

```bash
npx cli-box-skill install
```

Choose Claude Code, OpenCode, and/or OpenClaw (auto-detects installed ones). Or
non-interactively: `npx cli-box-skill install claude` (targets: `claude | opencode | openclaw | all`).
This installs the binaries to `~/.cli-box/bin/` and the skill into the chosen harness.

### Option B: Direct download

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh) claude
```

Pass one or more of `claude | opencode | openclaw`, or `all`.
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli-box-skill/skill/SKILL.md README.md README.zh-cn.md packages/cli-box-skill/README.md docs/guide/installation.md
git commit -m "docs(skill): npx cli-box-skill install across READMEs + guide"
```

---

## Task 7: Rewrite `tests/e2e-skill-install.sh` + wire skill tests into `test.sh`

**Files:**
- Modify: `tests/e2e-skill-install.sh`
- Modify: `test.sh`

- [ ] **Step 1: Rewrite the e2e test functions**

Open `tests/e2e-skill-install.sh`. Keep `ensure_platform_binaries()` and the helpers/skip-guard at the top unchanged. **Rewrite the three test functions** (`test_postinstall`, `test_install_sh`, `test_post_install_verify`) and the Main/Summary section so the file becomes:

```bash
#!/usr/bin/env bash
set -euo pipefail

# E2E Skill Installation Test
# Verifies (1) postinstall symlinks binaries but does NOT copy the skill,
# and (2) install.sh installs the skill into the specified target only.
# (The cli-box-skill CLI is covered by node:test in packages/cli-box-skill/test/.)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}➜${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
FAILED=0

if [ "$(uname)" = "Linux" ] && [ -n "${CI:-}" ]; then
  warn "Skipping E2E skill installation tests on Linux CI (macOS frameworks required)"
  exit 0
fi

ensure_platform_binaries() {
  local PKG_BIN="$REPO_ROOT/packages/cli-box-darwin-arm64/bin"
  if [ -f "$PKG_BIN/cli-box" ] && [ -f "$PKG_BIN/cli-box-daemon" ]; then return; fi
  info "Populating platform package bin/ with built binaries..."
  mkdir -p "$PKG_BIN"
  if [ ! -f "$REPO_ROOT/target/release/cli-box" ] && [ ! -f "$REPO_ROOT/target/debug/cli-box" ]; then
    info "  Building with cargo..."; cargo build -p cli-box-cli -p cli-box-daemon >/dev/null 2>&1 || { err "cargo build failed"; exit 1; }
  fi
  if [ -f "$REPO_ROOT/target/release/cli-box" ]; then
    ln -sf "$REPO_ROOT/target/release/cli-box" "$PKG_BIN/cli-box"
    ln -sf "$REPO_ROOT/target/release/cli-box-daemon" "$PKG_BIN/cli-box-daemon"
  else
    ln -sf "$REPO_ROOT/target/debug/cli-box" "$PKG_BIN/cli-box"
    ln -sf "$REPO_ROOT/target/debug/cli-box-daemon" "$PKG_BIN/cli-box-daemon"
  fi
  ok "Platform package binaries linked"
}

test_postinstall() {
  info "Test 1: postinstall (binaries only, no skill copy)"
  local TMP_HOME; TMP_HOME=$(mktemp -d)
  local SKILL_PKG_NM="$REPO_ROOT/packages/cli-box-skill/node_modules"
  local CREATED_NM=0
  cleanup_postinstall() {
    rm -rf "$TMP_HOME"
    if [ "$CREATED_NM" -eq 1 ]; then rm -rf "$SKILL_PKG_NM"; fi
  }
  trap cleanup_postinstall RETURN
  if [ ! -d "$SKILL_PKG_NM/cli-box-darwin-arm64" ]; then
    mkdir -p "$SKILL_PKG_NM"
    ln -s "$REPO_ROOT/packages/cli-box-darwin-arm64" "$SKILL_PKG_NM/cli-box-darwin-arm64"
    CREATED_NM=1
  fi
  if ! HOME="$TMP_HOME" node "$REPO_ROOT/packages/cli-box-skill/postinstall.mjs" 2>&1; then
    err "  postinstall.mjs exited non-zero"; FAILED=1; return
  fi
  [ -L "$TMP_HOME/.cli-box/bin/cli-box" ] && ok "  cli-box symlink created" || { err "  cli-box symlink NOT created"; FAILED=1; }
  [ -L "$TMP_HOME/.cli-box/bin/cli-box-daemon" ] && ok "  cli-box-daemon symlink created" || { err "  cli-box-daemon symlink NOT created"; FAILED=1; }
  # NEW: postinstall must NOT copy the skill anywhere
  if [ -e "$TMP_HOME/.claude/skills/cli-box/SKILL.md" ]; then
    err "  postinstall copied SKILL.md to .claude (should not)"; FAILED=1
  else
    ok "  postinstall did not copy SKILL.md (correct)"
  fi
  info "  Test 1 complete"
}

build_local_tarball() {
  local out="$1"
  local d; d=$(mktemp -d)
  mkdir -p "$d/bin"
  cp "$REPO_ROOT/packages/cli-box-skill/skill/SKILL.md" "$d/"
  if [ ! -f "$REPO_ROOT/target/release/cli-box" ] && [ ! -f "$REPO_ROOT/target/debug/cli-box" ]; then
    cargo build -p cli-box-cli -p cli-box-daemon >/dev/null 2>&1
  fi
  if [ -f "$REPO_ROOT/target/release/cli-box" ]; then
    cp "$REPO_ROOT/target/release/cli-box" "$d/bin/"; cp "$REPO_ROOT/target/release/cli-box-daemon" "$d/bin/"
  else
    cp "$REPO_ROOT/target/debug/cli-box" "$d/bin/"; cp "$REPO_ROOT/target/debug/cli-box-daemon" "$d/bin/"
  fi
  chmod +x "$d/bin/"*
  (cd "$d" && tar czf "$out" .)
  rm -rf "$d"
}

patch_install_sh() {
  # Make install.sh use a local tarball + fixed version instead of network.
  local src="$1" dst="$2" tarball="$3"
  cp "$src" "$dst"
  sed -i '' 's/VERSION="${CLI_BOX_VERSION:-latest}"/VERSION="local"/' "$dst"
  sed -i '' '/Fetching latest release version/,/fi/c\
info "Using local version"' "$dst"
  sed -i '' "s|DOWNLOAD_URL=\"https://github.com/\$REPO/releases/download/\$VERSION/cli-box-skill.tar.gz\"|DOWNLOAD_URL=\"file://$tarball\"|" "$dst"
}

test_install_sh() {
  info "Test 2: install.sh <target> (skill into chosen target only)"
  local TMP_HOME; TMP_HOME=$(mktemp -d)
  local TMP_DIR; TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_HOME" "$TMP_DIR"' RETURN
  local tarball="$TMP_DIR/cli-box-skill.tar.gz"
  build_local_tarball "$tarball" || { err "  tarball build failed"; FAILED=1; return; }
  local script="$TMP_DIR/install-local.sh"
  patch_install_sh "$REPO_ROOT/packages/cli-box-skill/skill/install.sh" "$script" "$tarball"
  if ! HOME="$TMP_HOME" bash "$script" claude >/dev/null 2>&1; then
    err "  install.sh claude exited non-zero"; FAILED=1; return
  fi
  [ -f "$TMP_HOME/.cli-box/bin/cli-box" ] && ok "  binaries installed" || { err "  binaries missing"; FAILED=1; }
  [ -f "$TMP_HOME/.claude/skills/cli-box/SKILL.md" ] && ok "  SKILL.md in Claude dir" || { err "  SKILL.md missing in Claude dir"; FAILED=1; }
  [ ! -e "$TMP_HOME/.config/opencode/skills/cli-box" ] && ok "  OpenCode dir untouched" || { err "  OpenCode dir should be untouched"; FAILED=1; }

  info "  Test 2b: install.sh with no target exits 1"
  local rc=0
  HOME="$TMP_HOME" bash "$script" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 1 ]; then err "  expected exit 1, got $rc"; FAILED=1; else ok "  no-target exit 1"; fi
  info "  Test 2 complete"
}

echo ""
echo "=============================================="
echo " E2E Skill Installation Tests"
echo "=============================================="
echo ""
ensure_platform_binaries; echo ""
test_postinstall; echo ""
test_install_sh; echo ""
echo "=============================================="
if [ "$FAILED" -eq 0 ]; then echo -e "${GREEN}All E2E skill installation tests passed!${NC}"; exit 0
else echo -e "${RED}Some E2E skill installation tests failed.${NC}"; exit 1; fi
```

- [ ] **Step 2: Run the rewritten e2e test**

Run: `CI=1 bash tests/e2e-skill-install.sh`
Expected: all tests pass (CI=1 is harmless here — there is no Electron-launch step in this version).

- [ ] **Step 3: Wire skill-package `node:test` into `test.sh`**

In `test.sh`, immediately before the `# ==================== E2E Skill Installation Tests ====================` section, insert:

```bash
# ==================== Skill Package Tests (node:test) ====================
info "Running skill package tests (shared + CLI)..."
if (cd packages/cli-box-skill && npm install --no-save --omit=optional --ignore-scripts >/dev/null 2>&1 && node --test test/) 2>&1; then
  ok "Skill package tests passed"
else
  err "Skill package tests FAILED"
  FAILED=1
fi
```

- [ ] **Step 4: Run the full local gate**

Run: `CI=1 bash test.sh 2>&1 | tail -40`
Expected: every section reports passed; final `All tests passed!`. (If the Playwright/Electron sections need a display they still run; the skill-related sections are what we changed.)

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-skill-install.sh test.sh
git commit -m "test(skill): e2e for postinstall(no copy)/install.sh(target); wire node:test into test.sh"
```

---

## Task 8: Version bump 0.2.6 → 0.2.7 + release-pipeline.md note

**Files:**
- Modify: `Cargo.toml`
- Modify: `electron-app/package.json`
- Modify: `release.sh`
- Modify: `release/release-pipeline.md`

- [ ] **Step 1: Bump the three manual version files**

Edit `Cargo.toml` (the `workspace.package.version` line): `0.2.6` → `0.2.7`.
Edit `electron-app/package.json` (`version`): `0.2.6` → `0.2.7`.
Edit `release.sh` (`VERSION=`): `0.2.6` → `0.2.7`.

- [ ] **Step 2: Add an installer note to `release/release-pipeline.md`**

In the `### 2. npm` section, append after the existing `cli-box-skill` row description:

```markdown
On install, `postinstall.mjs` only symlinks binaries and prints guidance — it does
**not** copy the skill. Users run `npx cli-box-skill install` (interactive) or
`cli-box-skill install <claude|opencode|openclaw|all>` (explicit) to place the
skill. `install.sh` (curl) takes the same target args. Skill targets: Claude Code
`~/.claude/skills/cli-box/`, OpenCode `~/.config/opencode/skills/cli-box/`,
OpenClaw `~/.openclaw/skills/cli-box/`.
```

Also update the doc's `**Version:**` line to `0.2.7`.

- [ ] **Step 3: Verify the bump**

Run: `grep -n '0.2.7' Cargo.toml electron-app/package.json release.sh`
Expected: three matches.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml electron-app/package.json release.sh release/release-pipeline.md
git commit -m "chore: bump version to 0.2.7 + document cli-box-skill installer"
```

---

## Final: push, PR, CI, tag, release

- [ ] Push the branch: `git push -u origin feat/cli-box-skill-installer-0.2.7`
- [ ] Open PR `feat(cli-box-skill): interactive installer + slim postinstall (0.2.7)` with Problem/Solution/Test Plan body; wait for CI Gate (Rust + clippy + fmt + frontend + the new skill node:test + rewritten e2e + release-build verify) to pass.
- [ ] Squash-merge to `main`, pull, `git tag -a v0.2.7 -m "Release v0.2.7"`, `git push origin v0.2.7`.
- [ ] `gh release create v0.2.7 --title "v0.2.7" --generate-notes` → triggers `release.yml` (build + GitHub assets + npm publish of the 3 packages at 0.2.7, including the new `cli-box-skill` bin).
- [ ] **Verify out-of-the-box** (matches the 0.2.6 check, adapted): in an isolated fresh HOME, `npx cli-box-skill install claude` → `~/.claude/skills/cli-box/SKILL.md` present, others absent; `npx cli-box-skill install all` → all three; bare `npx cli-box-skill install` in a non-TTY → exit 1 + guidance.

---

## Self-Review (completed)

**Spec coverage:**
- §5.1 postinstall slim → Task 4 ✓
- §5.2 `cli-box-skill install` command → Task 3 ✓
- §5.3 package.json (bin/files/deps) → Task 2 ✓
- §5.4 install.sh target arg → Task 5 ✓
- §5.5 SKILL.md → Task 6 ✓
- §5.6 READMEs agent sentence + one-liner → Task 6 ✓
- §5.7 installation.md → Task 6 ✓
- §6 harness targets & detection → Task 1 (`HARNESS_TARGETS`, `detectHarnesses`) ✓
- §7 error handling (no-target non-TTY → exit 1; unknown → error) → Task 1 (`parseTargets`) + Task 3 (`failNoTarget`) ✓
- §8 testing (unit + e2e rewrite) → Tasks 1, 3, 7 ✓
- §9 version bump 0.2.7 → Task 8 ✓
- shared `ensureBinaries()` DRY between postinstall and installer → Task 1 + Task 4 ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code; dep versions resolve via `npm install` in Task 2 (documented, not hardcoded guesses).

**Type/name consistency:** `parseTargets`, `detectHarnesses`, `installSkillToTargets`, `ensureBinaries`, `HARNESS_TARGETS`, `HARNESS_IDS` defined in Task 1 and used identically in Tasks 3–4. Harness ids `claude`/`opencode`/`openclaw` consistent across shared.mjs, cli.mjs, install.sh, READMEs, tests.
