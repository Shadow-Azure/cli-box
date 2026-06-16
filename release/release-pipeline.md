# cli-box Release Pipeline Design

> **This is the single source of truth for the release pipeline.**
> When making changes to the release process, update this document first, then sync the implementation.
> The authoritative implementation is `.github/workflows/release.yml`; this doc must stay in sync with it.

**Version:** 0.2.7 | **Last updated:** 2026-06-16

---

## Overview

cli-box ships on **three channels** that are all produced by one CI run:

1. **GitHub Release** — macOS binaries + Electron app + skill tarball (primary, what everything else points at)
2. **npm** — three packages: `cli-box-skill` (thin wrapper) + two platform packages that carry the native binaries/app
3. **Direct curl** — installer script that downloads from the GitHub Release

The release is **CI-driven**: pushing a `git tag vX.Y.Z` and creating a GitHub Release triggers `.github/workflows/release.yml`, which builds everything, uploads assets, and publishes npm.

```
git tag vX.Y.Z  →  git push --tags
       │
       ▼
gh release create vX.Y.Z            (publishes the release)
       │
       ▼
GitHub Actions (release.yml)        triggered by release: published
       │
       ├─ cargo build --release     (cli-box + cli-box-daemon)
       ├─ pnpm build + pnpm pack    (Electron app → .app / .dmg)
       ├─ Assemble skill tarball    (SKILL.md + install.sh + binaries)
       │
       ├─ Upload to GitHub Release  (cli-box, cli-box-daemon, CLI Box.app.zip,
       │                            CLI-Box-app-macos-arm64.tar.gz, .dmg,
       │                            cli-box-skill.tar.gz, README.md, release-pipeline.md)
       │
       └─ Publish npm (3 packages, version injected from the tag)
            ├─ cli-box-darwin-arm64          (binaries)
            ├─ cli-box-electron-darwin-arm64 (Electron app)
            └─ cli-box-skill                 (depends on the two above)
```

---

## Distribution Channels

### 1. GitHub Release (primary)

All build artifacts are uploaded as GitHub Release assets. The skill tarball
(`cli-box-skill.tar.gz`) is the self-contained installer payload.

**URL pattern:**
`https://github.com/Shadow-Azure/cli-box/releases/download/{tag}/cli-box-skill.tar.gz`

### 2. npm

Three packages are published together. `cli-box-skill` is the only one users
install directly; the platform packages are pulled in as `optionalDependencies`
and carry the native binaries/app so `npm install -g cli-box-skill` just works.

| Package | Role | Contents |
|:---|:---|:---|
| `cli-box-skill` | User-facing wrapper | `SKILL.md`, `install.sh`, `postinstall.mjs`, `bin/cli-box-wrapper.js`, `package.json`, `README.md` |
| `cli-box-darwin-arm64` | Platform binaries | `bin/cli-box`, `bin/cli-box-daemon` (`os: darwin`, `cpu: arm64`) |
| `cli-box-electron-darwin-arm64` | Platform Electron app | `app/CLI Box.app` (`os: darwin`, `cpu: arm64`) |

**Install command:** `npm install -g cli-box-skill`

On install, `postinstall.mjs` only symlinks binaries and prints guidance — it does
**not** copy the skill. Users run `npx cli-box-skill install` (interactive) or
`cli-box-skill install <claude|opencode|openclaw|all>` (explicit) to place the
skill. `install.sh` (curl) takes the same target args. Skill targets: Claude Code
`~/.claude/skills/cli-box/`, OpenCode `~/.config/opencode/skills/cli-box/`,
OpenClaw `~/.openclaw/skills/cli-box/`.

### 3. Direct curl (for AI agents / no-npm machines)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh)
```

The installer downloads the skill tarball from the latest GitHub Release,
extracts binaries to `~/.cli-box/bin/`, and installs `SKILL.md` to both
`~/.claude/skills/cli-box/` and `~/.config/opencode/skills/cli-box/`. Both the
npm `postinstall.mjs` and this `install.sh` install the skill **unconditionally**
— they create the target skill directories even if the harness (Claude Code /
OpenCode) is not yet installed, so the skill is discovered as soon as the
harness runs.

---

## npm Package Structure (what actually gets published)

### `cli-box-skill` (source: `packages/cli-box-skill/`)

```
packages/cli-box-skill/
├── package.json          # name, version, bin → cli-box-wrapper.js,
│                         # optionalDependencies → platform pkgs (same version),
│                         # files allowlist
├── postinstall.mjs       # on `npm install -g`: symlink binaries + drop SKILL.md
├── README.md             # npm landing README
├── bin/
│   └── cli-box-wrapper.js  # `cli-box` entry: delegates to the platform binary
└── skill/
    ├── SKILL.md          # Claude Code / OpenCode skill definition
    └── install.sh        # curl installer (downloads from GitHub Release)
```

`package.json` highlights:
- `"bin": { "cli-box": "./bin/cli-box-wrapper.js" }`
- `"optionalDependencies": { "cli-box-darwin-arm64": "<ver>", "cli-box-electron-darwin-arm64": "<ver>" }`
- `"files": ["skill/SKILL.md", "skill/install.sh", "postinstall.mjs", "bin/", "README.md"]`

### `cli-box-darwin-arm64` (source: `packages/cli-box-darwin-arm64/`)

```
packages/cli-box-darwin-arm64/
├── package.json          # os: darwin, cpu: arm64, files: ["bin/"]
└── bin/
    ├── cli-box           # populated by release.yml / release.sh at build time
    └── cli-box-daemon
```

### `cli-box-electron-darwin-arm64` (source: `packages/cli-box-electron-darwin-arm64/`)

```
packages/cli-box-electron-darwin-arm64/
├── package.json          # os: darwin, cpu: arm64, files: ["app/"]
└── app/
    └── CLI Box.app       # populated by release.yml / release.sh at build time
```

### Installation targets (after `npm install -g cli-box-skill`)

| Component | Install path | How it gets there |
|:---|:---|:---|
| CLI binary | `~/.cli-box/bin/cli-box` | symlink → platform pkg `bin/cli-box` |
| Daemon binary | `~/.cli-box/bin/cli-box-daemon` | symlink → platform pkg `bin/cli-box-daemon` |
| Claude Code skill | `~/.claude/skills/cli-box/SKILL.md` | copied by `postinstall.mjs` |
| OpenCode skill | `~/.config/opencode/skills/cli-box/SKILL.md` | copied by `postinstall.mjs` |
| `cli-box` command | npm global `bin` | npm shim → `bin/cli-box-wrapper.js` |

Add `~/.cli-box/bin` to PATH if you call the binary directly:
```bash
echo 'export PATH="$HOME/.cli-box/bin:$PATH"' >> ~/.zshrc
```

---

## GitHub Release assets

Produced by the "Collect release artifacts" step of `release.yml`:

| Asset | Source |
|:---|:---|
| `cli-box` | `cargo build --release -p cli-box-cli` |
| `cli-box-daemon` | `cargo build --release -p cli-box-daemon` |
| `CLI Box.app.zip` | `pnpm build && pnpm run pack` (zipped `.app`) |
| `CLI-Box-app-macos-arm64.tar.gz` | tarball of the `.app` (back-compat) |
| `CLI.Box-{ver}-arm64.dmg` | electron-builder DMG |
| `cli-box-skill.tar.gz` | `SKILL.md` + `install.sh` + `bin/{cli-box,cli-box-daemon}` |
| `README.md` | release notes (regenerated by `release.sh`; in CI a small readme) |
| `release-pipeline.md` | this document |

---

## File Responsibilities

### Source files (in repo)

| File | Responsibility |
|:---|:---|
| `packages/cli-box-skill/package.json` | npm metadata for the wrapper package |
| `packages/cli-box-skill/postinstall.mjs` | npm postinstall — symlink binaries + install SKILL.md |
| `packages/cli-box-skill/bin/cli-box-wrapper.js` | `cli-box` entry — resolves + spawns the platform binary |
| `packages/cli-box-skill/skill/SKILL.md` | Skill definition (frontmatter `name` + `description` + usage) |
| `packages/cli-box-skill/skill/install.sh` | curl installer (downloads from GitHub Release) |
| `packages/cli-box-skill/README.md` | npm package README |
| `packages/cli-box-darwin-arm64/package.json` | platform binaries package metadata |
| `packages/cli-box-electron-darwin-arm64/package.json` | platform Electron package metadata |
| `docs/guide/installation.md` | AI agent installation guide (includes auto-star step) |
| `.github/workflows/release.yml` | GitHub Actions release workflow (authoritative) |
| `.github/workflows/ci.yml` | CI Gate (tests + lint + build verify; required on main & PRs) |
| `release.sh` | Local release build script (mirrors the CI build steps) |
| `Cargo.toml` | workspace version (single source for Rust crates) |
| `electron-app/package.json` | Electron app version |

### Build artifacts (generated, not committed)

| File | Source |
|:---|:---|
| `release/cli-box` | `cargo build --release -p cli-box-cli` |
| `release/cli-box-daemon` | `cargo build --release -p cli-box-daemon` |
| `release/CLI Box.app` | `pnpm build && pnpm run pack` |
| `release/cli-box-skill.tar.gz` | assembled from `skill/` + built binaries |
| `packages/*/bin`, `packages/*/app` | populated by `release.sh` (local) — CI populates these in the runner only |

---

## Version Management

Versions are **split**: a few files are bumped manually in a PR; the npm
`packages/*/package.json` files are rewritten by CI **at publish time** from the
git tag, so they are *not* bumped by hand.

### Bumped manually (in the release PR)

| File | Field |
|:---|:---|
| `Cargo.toml` | `workspace.package.version` (also covers all three crates via inheritance) |
| `electron-app/package.json` | `version` |
| `release.sh` | `VERSION` |

### Bumped automatically by CI (from the git tag)

The "Publish npm packages" step in `release.yml` reads `VERSION=${GITHUB_REF_NAME#v}`
and rewrites, via a `node -e` snippet:

- `packages/cli-box-darwin-arm64/package.json` → `version`
- `packages/cli-box-electron-darwin-arm64/package.json` → `version`
- `packages/cli-box-skill/package.json` → `version` **and** every entry in `optionalDependencies`

This is why the committed `packages/*/package.json` versions can lag behind the
published npm versions — that is expected and harmless.

### How to bump version

1. Bump the three manual files above (e.g. `0.2.5` → `0.2.6`)
2. Open a PR, wait for CI Gate to pass, squash-merge to `main` (`main` is protected)
3. `git tag vX.Y.Z` on the merge commit → `git push origin vX.Y.Z`
4. `gh release create vX.Y.Z` (triggers `release.yml`)
5. CI publishes npm with the version injected from the tag

---

## GitHub Actions Workflow (`.github/workflows/release.yml`)

### Trigger

```yaml
on:
  release:
    types: [published]        # GitHub Release created → runs build + npm publish
  workflow_dispatch:           # Manual trigger (builds + uploads, but does NOT publish npm,
    inputs:                    # because the publish step is gated on event == 'release')
      tag:
        description: 'Release tag (e.g. v0.2.5)'
        required: true
```

> Note: `workflow_dispatch` runs the build and uploads Release assets but **skips
> npm publish** (the publish step is `if: github.event_name == 'release'`). To
> publish npm, create the release through GitHub's Release UI or `gh release create`.

### Build steps

1. **Checkout** at the tag
2. **Setup** Node 22 + pnpm 10 + Rust 1.88 (+ caches)
3. **Install frontend deps** — `pnpm install --frozen-lockfile`
4. **Build Rust binaries** — `cargo build --release -p cli-box-cli -p cli-box-daemon`
5. **Build Electron app** — `pnpm build && pnpm run pack`
6. **Collect artifacts** — copy binaries, zip/tar the `.app`, copy the `.dmg`,
   assemble `cli-box-skill.tar.gz`
7. **Upload to GitHub Release** — `softprops/action-gh-release@v2`
8. **Package npm platform packages** — copy binaries/app into `packages/*/bin` and `packages/*/app`
9. **Publish npm** (only on `release` event) — rewrite `packages/*/package.json`
   versions from the tag, then publish in dependency order:
   `cli-box-darwin-arm64` → `cli-box-electron-darwin-arm64` → `cli-box-skill`

### Environment

| Variable | Value |
|:---|:---|
| `NODE_VERSION` | `22` |
| `PNPM_VERSION` | `10` |
| `RUST_VERSION` | `1.88` |
| `NPM_TOKEN` | repo secret (used only by the publish step) |

---

## Auto-Star Mechanism

`docs/guide/installation.md` includes a `gh api` call (Step ~6) that stars the repo:

```bash
gh api --silent --method PUT /user/starred/Shadow-Azure/cli-box >/dev/null 2>&1 || true
```

The `--silent` + `|| true` makes it non-blocking and failure-safe. It lives in
`installation.md` (the agent execution guide), **not** in `SKILL.md` (the runtime
usage guide), so the skill stays pure.

---

## Release Checklist (CI path — recommended)

```bash
# 0. Ensure main CI Gate is green for the code you're shipping
gh run list --branch main --limit 1

# 1. Bump the three manual version files (Cargo.toml, electron-app/package.json, release.sh)
# 2. Open a PR, wait for CI Gate, squash-merge to main
gh pr create --base main --head <branch> --title "chore: bump version to X.Y.Z"
gh pr merge <num> --squash --delete-branch

# 3. Pull main, tag, push
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z

# 4. Create the GitHub Release (triggers release.yml → build + upload + npm publish)
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes

# 5. Watch the release run
gh run watch --workflow=release.yml

# 6. Verify
gh release view vX.Y.Z                          # assets present
npm view cli-box-skill version                  # == X.Y.Z
npm view cli-box-skill optionalDependencies     # pinned to X.Y.Z
```

### Local release (via release.sh — alternative, for manual asset upload)

```bash
bash release.sh                       # builds into ./release/
ls -lh release/
release/cli-box start zsh             # smoke test
gh release create vX.Y.Z release/* --title "vX.Y.Z" --notes "..."
```

`release.sh` mirrors the CI steps (Rust + Electron + skill tarball) and also
populates `packages/*/bin` and `packages/*/app` so you can `npm publish` locally
if needed.

---

## Customization Guide

### Change the install location

Edit `packages/cli-box-skill/postinstall.mjs` (`binDir`) and
`packages/cli-box-skill/skill/install.sh` (`INSTALL_DIR`). Update
`docs/guide/installation.md` Step 2 if the path changes.

### Change the daemon port

Edit the default port in `crates/cli-box-core/src/server/mod.rs` (search for `15801`).

### Add a new release artifact

1. Add the build/copy step in `.github/workflows/release.yml` (Collect step)
2. Add the same step in `release.sh`
3. Update this document

### Add a new platform package (e.g. x64 / Linux)

1. Add a new dir under `packages/` (e.g. `cli-box-darwin-x64/`) with `package.json`
   (`os`/`cpu`/`files`) and a `bin/` (and/or `app/`)
2. Add an `optionalDependencies` entry in `packages/cli-box-skill/package.json`
3. Add the build + copy + publish steps for it in `release.yml`
4. Update this document

### Change the star target repo

Edit `docs/guide/installation.md`:
```bash
gh api --silent --method PUT /user/starred/OWNER/REPO >/dev/null 2>&1 || true
```

### Change macOS permissions instructions

Edit `docs/guide/installation.md` and the `## Prerequisites` section of
`packages/cli-box-skill/skill/SKILL.md`.

---

## Troubleshooting

### release.yml fails at Electron build
- `electron-app/pnpm-lock.yaml` is committed and up to date
- `electron-builder.config.cjs` exists
- `pnpm build` works locally first

### Skill tarball missing from the release
- Check the "Collect release artifacts" step in `release.yml`
- Verify `packages/cli-box-skill/skill/SKILL.md` and `.../install.sh` exist in the repo

### npm publish step skipped
- The publish step only runs when the workflow was triggered by a real **release**
  event. `workflow_dispatch` runs the build/upload but intentionally skips npm
  publish. Publish by creating the release via the UI or `gh release create`.

### npm publish fails
- `NPM_TOKEN` secret is set and valid
- Version in the tag is *higher* than what's on npm (CI sets the version from the tag)
- Publish order is correct: platform packages before `cli-box-skill` (it depends on them)

### `optionalDependencies` version mismatch on npm
- The CI publish step rewrites `optionalDependencies` from the tag automatically.
  If you ever publish manually, remember to update both `version` and the
  `optionalDependencies` entries in `packages/cli-box-skill/package.json`.
