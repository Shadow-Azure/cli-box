// Pure logic for the cli-box skill installer. Zero external dependencies
// (node: builtins only) so it can be unit-tested without `npm install`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function hasBinary(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  const candidate =
    process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  return dirs.some((d) => candidate.some((c) => safeExists(path.join(d, c))));
}

// Harness order matches HARNESS_IDS sort used in tests:
// ["claude", "openclaw", "opencode"].
export const HARNESS_TARGETS = {
  claude: {
    label: "Claude Code",
    skillDir: (home) => path.join(home, ".claude", "skills", "cli-box"),
    detect: (home) => safeExists(path.join(home, ".claude")),
  },
  openclaw: {
    label: "OpenClaw",
    skillDir: (home) => path.join(home, ".openclaw", "skills", "cli-box"),
    detect: (home) => safeExists(path.join(home, ".openclaw")),
  },
  opencode: {
    label: "OpenCode",
    skillDir: (home) =>
      path.join(home, ".config", "opencode", "skills", "cli-box"),
    detect: (home) => safeExists(path.join(home, ".config", "opencode")),
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

// Returns the list of harness ids whose config directory exists under `home`.
// Detection is directory-based only, so it is deterministic per home and
// independent of the ambient PATH (important for testability and for
// answering "which harnesses are initialized in THIS home").
export function detectHarnesses(home = os.homedir()) {
  return HARNESS_IDS.filter((id) => HARNESS_TARGETS[id].detect(home));
}

export function readBundledSkill() {
  return fs.readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
}

// Per-harness additions appended to the bundled SKILL.md body.
// Returns "" when the target needs no customization.
export function targetSpecificNote(id) {
  if (id === "openclaw") {
    return [
      "",
      "## Notes for OpenClaw",
      "",
      "OpenClaw can only read files under `/tmp/openclaw/`. When you take a",
      "screenshot, **write the output there** or OpenClaw cannot read or send the",
      "image:",
      "",
      "```bash",
      "cli-box screenshot --id <sandbox-id> -o /tmp/openclaw/screenshot.png",
      "```",
      "",
      "The directory is created automatically. Do not write screenshots to the",
      "current working directory when driving an OpenClaw agent.",
      "",
    ].join("\n");
  }
  return "";
}

// Writes the skill body into each target dir. Returns [{id, dir, ok, error?}].
export function installSkillToTargets(ids, { home = os.homedir(), content } = {}) {
  return ids.map((id) => {
    const dir = HARNESS_TARGETS[id].skillDir(home);
    try {
      const body = (content ?? readBundledSkill()) + targetSpecificNote(id);
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
// Try to install a platform package from the official npmjs.org registry.
// This is a fallback when the user's configured registry (e.g., npmmirror)
// doesn't have the required version due to mirror sync lag.
function tryInstallFromOfficialRegistry(pkgName) {
  try {
    // Read the expected version from this package's optionalDependencies
    const selfPkg = require.resolve("../package.json");
    const { optionalDependencies } = JSON.parse(fs.readFileSync(selfPkg, "utf8"));
    const version = optionalDependencies?.[pkgName];
    if (!version) return false;

    execSync(
      `npm install ${pkgName}@${version} --registry=https://registry.npmjs.org --no-save`,
      { stdio: "ignore", timeout: 60_000 }
    );
    return true;
  } catch {
    return false;
  }
}

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
    // Fallback: try installing from the official npmjs.org registry
    if (tryInstallFromOfficialRegistry(pkgName)) {
      try {
        pkgDir = path.dirname(require.resolve(`${pkgName}/package.json`));
      } catch {
        return { ok: false, reason: `platform package ${pkgName} not found (fallback failed)`, binDir };
      }
    } else {
      return { ok: false, reason: `platform package ${pkgName} not found`, binDir };
    }
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
