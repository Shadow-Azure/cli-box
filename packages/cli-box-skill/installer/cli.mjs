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
