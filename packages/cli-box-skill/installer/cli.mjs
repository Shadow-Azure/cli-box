#!/usr/bin/env node
// cli-box-skill — installer for the cli-box skill into agent harnesses.
// Usage:
//   npx cli-box-skill install              # interactive (TTY)
//   cli-box-skill install claude opencode  # explicit
//   cli-box-skill install all              # all harnesses
//   cli-box-skill install --no-tui claude  # non-interactive explicit
import { Command } from "commander";
import * as clack from "@clack/prompts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_IDS,
  HARNESS_TARGETS,
  parseTargets,
  detectHarnesses,
  installSkillToTargets,
  ensureBinaries,
  readDaemonInfo,
  isProcessAlive,
  listRunningSandboxes,
  closeSandbox,
  shutdownDaemon,
  killElectron,
  waitForProcessExit,
  npmInstall,
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

const CLI_BOX_DIR = path.join(os.homedir(), ".cli-box");

async function runUpgrade(targetVersion, opts = {}) {
  const version = targetVersion || "latest";
  const pkg = `cli-box-skill@${version}`;

  // 1. Check daemon
  const daemon = readDaemonInfo();
  if (daemon && isProcessAlive(daemon.pid)) {
    console.log(`  ℹ Daemon running (PID ${daemon.pid}, port ${daemon.port})`);

    // 2. List sandboxes
    const sandboxes = await listRunningSandboxes(daemon.port);
    if (sandboxes.length > 0) {
      console.log(`\n  ⚠ ${sandboxes.length} sandbox(es) running:`);
      for (const sb of sandboxes) {
        const id = sb.id || sb.instance_id || "unknown";
        const title = sb.title || sb.command || "";
        console.log(`    • ${id}  ${title}`);
      }
      console.log(
        "\n  Upgrade requires stopping all sandboxes and the daemon."
      );

      if (isTTY) {
        const confirm = await clack.confirm({
          message: "Close all sandboxes and proceed with upgrade?",
          initialValue: false,
        });
        if (clack.isCancel(confirm) || !confirm) {
          console.log("Cancelled.");
          process.exit(0);
        }
      } else if (!opts.yes) {
        console.error(
          "Non-interactive shell. Use --yes to confirm, or close sandboxes manually first."
        );
        process.exit(1);
      }

      // 3. Close all sandboxes
      console.log("\n  Closing sandboxes...");
      for (const sb of sandboxes) {
        const id = sb.id || sb.instance_id;
        const ok = await closeSandbox(daemon.port, id);
        console.log(ok ? `  ✓ Closed ${id}` : `  ⚠ Failed to close ${id}`);
      }

      // 4. Shutdown daemon
      console.log("  Shutting down daemon...");
      await shutdownDaemon(daemon.port);
      if (!waitForProcessExit(daemon.pid, 10000)) {
        console.warn("  ⚠ Daemon did not exit in time, force killing...");
        try {
          process.kill(daemon.pid, "SIGKILL");
        } catch {}
      }
      // Clean up daemon.json
      try {
        const daemonJson = path.join(CLI_BOX_DIR, "daemon.json");
        fs.unlinkSync(daemonJson);
      } catch {}
      console.log("  ✓ Daemon stopped");

      // 5. Kill Electron
      console.log("  Stopping Electron...");
      killElectron();
      console.log("  ✓ Electron stopped");
    } else {
      // No sandboxes, just shutdown daemon
      console.log("  No sandboxes running. Shutting down daemon...");
      await shutdownDaemon(daemon.port);
      waitForProcessExit(daemon.pid, 10000);
      killElectron();
      console.log("  ✓ Daemon stopped");
    }
  } else {
    console.log("  ℹ No daemon running");
    // Still try to kill stale Electron
    killElectron();
  }

  // 6. npm install
  console.log(`\n  Installing ${pkg}...`);
  try {
    npmInstall(pkg);
    console.log(`\n  ✓ cli-box upgraded to ${version}.`);
    console.log("    Run 'cli-box start' to begin.");
  } catch (e) {
    console.error(`\n  ✗ npm install failed: ${e.message}`);
    console.error(`    Try manually: npm install -g ${pkg}`);
    process.exit(1);
  }
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

program
  .command("upgrade")
  .description("Upgrade cli-box to a new version (stops running sandboxes)")
  .argument("[version]", "target version (default: latest)")
  .option("--yes", "Skip confirmation prompt")
  .action(async (version, opts) => {
    try {
      await runUpgrade(version, opts);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
