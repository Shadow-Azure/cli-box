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
