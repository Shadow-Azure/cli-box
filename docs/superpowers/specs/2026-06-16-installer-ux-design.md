# cli-box-skill Interactive Installer — Design

**Date:** 2026-06-16
**Target version:** 0.2.7
**Status:** Draft (awaiting user review)

---

## 1. Problem

After `npm install -g cli-box-skill`, the skill is currently copied into **every**
harness directory unconditionally (a behavior introduced in 0.2.6). Users who only
use one harness (e.g. only Claude Code) get the skill dropped into OpenCode /
OpenClaw directories they don't want. There is also no way to choose the target,
and a third harness (**OpenClaw**, `~/.openclaw/skills/`) is now in scope.

We want an installer that lets the user **choose** which harness(es) receive the
skill, in a way that is:

- **AI-agent friendly** — a single self-contained, executable sentence in the README
  that an agent can read and run.
- **Human friendly** — a one-line command, or a short interactive prompt.
- **CI/Docker safe** — never hangs on an interactive prompt in a non-TTY context.

## 2. Reference

`oh-my-openagent` (the style reference for this project) solves the identical
problem by keeping `postinstall.mjs` **minimal and non-interactive** (it only
verifies the platform binary) and putting all harness selection/installation in a
dedicated CLI command (`omo install` / `oh-my-opencode install`) built with
`commander` + `@clack/prompts`, supporting both interactive (`@clack` prompts) and
non-interactive (`--no-tui` + flags) modes. We adopt the same pattern.

npm itself has no clean "pass params to postinstall" mechanism: `--flag=value` is
forwarded as `npm_config_*` but npm prints an `Unknown cli config` warning and the
official guidance discourages interactive/scripted params in install scripts. A
dedicated bin command is the ecosystem-standard answer.

## 3. Goals / Non-goals

**Goals**

- New `cli-box-skill install` command: choose harness(es) interactively or via args.
- Support three harness targets: Claude Code, OpenCode, OpenClaw.
- `postinstall.mjs` becomes minimal (binaries only + a one-line guidance message);
  it no longer copies skills or prompts.
- `install.sh` (curl fallback) accepts a target arg; prints a hint and exits if none.
- All READMEs contain a single agent-executable sentence + a human one-liner.

**Non-goals**

- No change to the Rust `cli-box`/`cli-box-daemon` binaries or daemon behavior.
- No change to the release pipeline (still 3 npm packages; version injected from tag).
- No interactive shell menus inside `postinstall.mjs` (explicitly avoided).
- No support for harnesses beyond Claude Code / OpenCode / OpenClaw in this version.

## 4. Architecture

```
User
 │
 ├─ npx cli-box-skill install            ← interactive multi-select (primary entry)
 ├─ cli-box-skill install claude opencode← non-interactive, explicit
 │
 ▼
cli-box-skill  (NEW Node bin: bin/cli-box-skill.mjs, commander + @clack/prompts)
 │  resolve targets → copy SKILL.md into each chosen harness skill dir
 │
 ├─ Claude Code  → ~/.claude/skills/cli-box/SKILL.md
 ├─ OpenCode     → ~/.config/opencode/skills/cli-box/SKILL.md
 └─ OpenClaw     → ~/.openclaw/skills/cli-box/SKILL.md

postinstall.mjs (slimmed): symlink binaries → ~/.cli-box/bin/ + print guidance.
                            Does NOT copy skills, does NOT prompt.

install.sh (curl fallback): download binaries + install SKILL.md to the
                            target(s) passed as args (or CLI_BOX_TARGETS env);
                            no args → print hint + exit 1.
```

The runtime `cli-box` command (Rust binary) is untouched; it is still exposed via
the existing `bin/cli-box-wrapper.js` → platform package binary. The new
`cli-box-skill` bin is a separate, small Node program whose only job is skill
installation.

## 5. Component changes

### 5.1 `packages/cli-box-skill/postinstall.mjs`

- **Remove** the unconditional `SKILL.md` copy loop (the 0.2.6 change).
- Keep: platform-package resolution + symlink `cli-box`/`cli-box-daemon` into
  `~/.cli-box/bin/` (essential; `cli-box` must work after install).
- Append a guidance message:
  ```
  cli-box binaries are installed. To set up the skill in your agent harness, run:
    npx cli-box-skill install
  (or: npx cli-box-skill install claude | opencode | openclaw | all)
  ```
- Must remain non-interactive and never throw on missing platform package (warn +
  exit 0, as today) so installs never fail.

### 5.2 `packages/cli-box-skill/bin/cli-box-skill.mjs` (NEW)

Node ESM script. Uses `commander` for parsing and `@clack/prompts` for the
interactive multi-select.

Command surface:

```
cli-box-skill install [targets...]      install the skill into the given harness(es)
                                        targets: claude | opencode | openclaw | all
                                        (space-separated; `all` = all three)
cli-box-skill install                   no args + TTY  → interactive multi-select
cli-box-skill install                   no args + !TTY → error, exit 1 (no hang)
cli-box-skill install --no-tui <targets> explicit non-interactive
cli-box-skill --version / -h            version / help
```

Behavior:

1. **Ensure binaries are symlinked** into `~/.cli-box/bin/` (idempotent) by calling
   a shared `ensureBinaries()` helper that `postinstall.mjs` also uses. This makes
   `npx cli-box-skill install` self-sufficient even if a global install's
   postinstall was skipped (`--ignore-scripts`).
2. Resolve effective targets with precedence:
   `positional args` > (error if `--no-tui` and none) > interactive prompt (TTY) > error (!TTY).
3. Interactive prompt: `@clack/prompts` multiselect of the 3 harnesses; options
   pre-checked = detected harnesses; user toggles the ones they want (checking all
   three == `all`). Empty confirmation → "no target selected, nothing to do", exit 0.
4. For each chosen target: `mkdir -p <dir>` + copy the bundled `skill/SKILL.md`
   (read relative to the script) to `<dir>/SKILL.md`. Idempotent (overwrites).
5. Print a summary: which harnesses got the skill, plus the PATH hint
   (`~/.cli-box/bin`) if not already on PATH.

> Shared helper: extract `ensureBinaries()` (platform-package resolution +
> symlink) into `bin/shared.mjs` so both `postinstall.mjs` and the installer use
> one implementation (DRY).

### 5.3 `packages/cli-box-skill/package.json`

- Add bin: `"cli-box-skill": "./bin/cli-box-skill.mjs"` (keep `"cli-box"` wrapper).
- Add `dependencies`: `commander`, `@clack/prompts`.
- `files` already includes `bin/`, `skill/SKILL.md`; ensure `bin/cli-box-skill.mjs`
  is shipped (it is, under `bin/`).

> Note: `bin/cli-box-skill.mjs` must be force-added to git if the earlier
> observed "git add refuses paths under `packages/cli-box-skill/bin`" quirk recurs
> (the dir is tracked but `git add` without `-f` was refused in the 0.2.6 work).

### 5.4 `packages/cli-box-skill/skill/install.sh` (curl fallback)

- Accept targets via positional args (`bash install.sh claude opencode`) or env
  (`CLI_BOX_TARGETS=claude,opencode bash install.sh`); `all` supported.
- Existing behavior (download tarball, extract binaries to `~/.cli-box/bin/`) stays.
- New: after binaries, install `SKILL.md` to the **specified** target dir(s) only.
- **No target provided** → print a hint and exit 1:
  ```
  Usage: bash install.sh <claude|opencode|openclaw|all> [more...]
    or:  CLI_BOX_TARGETS=claude,opencode bash install.sh
  No target given — re-run with one of the targets above.
  ```
- Rationale: curl users sometimes pipe stdin (`curl | bash`), so an interactive
  menu is unreliable here; requiring an explicit arg + hint is robust and matches
  the npm command's no-target error behavior.

### 5.5 `packages/cli-box-skill/skill/SKILL.md`

Update the **Installation** section to:

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

### 5.6 READMEs — agent sentence + human one-liner (core requirement)

The same Installation block goes in **`README.md`**, **`README.zh-cn.md`**, and
**`packages/cli-box-skill/README.md`** (zh-cn gets a Chinese version of the same
content). Exact English block:

```markdown
## Installation

> **For AI agents:** run `npx cli-box-skill install all` to install the cli-box
> skill into every supported harness (Claude Code, OpenCode, OpenClaw), or replace
> `all` with `claude` / `opencode` / `openclaw` for a single target.

### Interactive (recommended for humans)
```bash
npx cli-box-skill install
```
Pick Claude Code, OpenCode, and/or OpenClaw.

### One-liner
```bash
npx cli-box-skill install claude    # claude | opencode | openclaw | all
```

### No npm?
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Shadow-Azure/cli-box/main/packages/cli-box-skill/skill/install.sh) claude
```
```

The `> For AI agents: ...` line is the self-contained, executable sentence. The TL;DR
table in the READMEs is updated so the **npm** row points to
`npx cli-box-skill install` and the **Shell** row shows the curl command with a
target arg.

### 5.7 `docs/guide/installation.md`

- Option A (npm): `npx cli-box-skill install` (interactive) or with explicit target.
- Option B (direct download): curl with a target arg.
- Keep the existing macOS-permissions and first-use steps.

## 6. Harness targets & detection

| Harness | Skill install path | "Detected" heuristic |
|:---|:---|:---|
| Claude Code | `~/.claude/skills/cli-box/SKILL.md` | `~/.claude` exists |
| OpenCode | `~/.config/opencode/skills/cli-box/SKILL.md` | `~/.config/opencode` exists |
| OpenClaw | `~/.openclaw/skills/cli-box/SKILL.md` | `~/.openclaw` exists |

Detection is **directory-based only** (not PATH). A config dir existing is a
sound, deterministic per-home signal of "this harness is in use here", and it
keeps `detectHarnesses(home)` testable — independent of the ambient PATH (which
on a dev machine may have all three CLIs installed). Detection only affects
**pre-checking** in the interactive menu; it never blocks installing into a
non-detected harness (the user may pre-install the skill before the harness
config dir exists).

## 7. Error handling

- **Non-TTY + no target (`cli-box-skill install`):** exit 1, message:
  `Non-interactive shell. Specify targets: cli-box-skill install <claude|opencode|openclaw|all>`.
- **`--no-tui` + no target:** same error.
- **Interactive Ctrl-C / cancel:** clean exit 0 (no partial writes; `@clack` handles
  cancel).
- **Per-target write failure:** warn that target, continue with the others, print a
  summary at the end; exit non-zero only if zero targets succeeded.
- **Unknown target string:** error listing valid targets; exit 1.
- **postinstall missing platform package:** warn + exit 0 (do not fail the install),
  unchanged from today.

## 8. Testing

### Unit tests (vitest, new file `bin/cli-box-skill.test.ts` or `.test.mjs`)

- Target resolution: positional → list; `all` → 3; unknown → error.
- `--no-tui` + no target → throws / exits non-zero.
- Detection heuristic: given mocked HOME/PATH, returns the right detected set.
- Precedence (positional > interactive > error) using a TTY stub.

### E2E (`tests/e2e-skill-install.sh`, rewritten)

- **Test 1 (postinstall):** assert binaries symlinked into `~/.cli-box/bin`; assert
  SKILL.md is **NOT** copied by postinstall anymore (behavior changed from 0.2.6).
- **Test 2 (`cli-box-skill install claude`):** in an isolated HOME, run the
  installer with `claude` → assert `~/.claude/skills/cli-box/SKILL.md` exists and
  OpenCode/OpenClaw dirs do **not**.
- **Test 3 (`install all`):** assert all three targets populated.
- **Test 4 (no-target, non-TTY):** set `CI=1` (non-TTY), run `cli-box-skill install`
  → expect non-zero exit + the guidance message.
- **Test 5 (install.sh):** `bash install.sh claude` populates Claude target; no-arg
  → hint + exit 1.

### Manual / release test

- `release_test.md` adds: `npx cli-box-skill install claude` (fresh HOME) → verify
  skill placement; screenshot the interactive prompt.

## 9. Version & rollout

- Bump `0.2.6 → 0.2.7` in `Cargo.toml`, `electron-app/package.json`, `release.sh`
  (the 3 manual files; npm package versions injected from tag by CI).
- Branch `feat/cli-box-skill-installer-0.2.7`, PR, CI Gate (including the rewritten
  e2e test), squash-merge, tag `v0.2.7`, `gh release create` → CI publishes the 3
  npm packages at 0.2.7 with the new `cli-box-skill` bin.
- **Reverts the 0.2.6 "unconditional skill copy" behavior** — this is intentional
  and documented in the release notes.

## 10. Decisions log

| Decision | Choice | Why |
|:---|:---|:---|
| Where selection lives | Dedicated `cli-box-skill install` command | Matches `oh-my-openagent`; CI-safe; npm has no clean postinstall-param mechanism |
| postinstall behavior | Minimal: binaries + guidance only | Avoid hangs; convention |
| `install.sh` no-arg | Print hint + exit 1 (target required) | User request; curl stdin fragility makes interactive menus unreliable |
| npm command no-arg, non-TTY | Error + exit 1 | Consistency; never hang |
| Interactive lib | `@clack/prompts` | Same as reference repo; polished TTY UI |
| Harness set | Claude Code + OpenCode + OpenClaw | User scope; OpenClaw uses `~/.openclaw/skills/` (AgentSkills spec) |
