import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const canonicalAgentFiles = Object.freeze([
  ".agents/AGENTS.md",
  ".agents/skills/mavula-review/SKILL.md",
  ".agents/skills/mavula-review/agents/openai.yaml",
  ".agents/skills/mavula-cloud-banking/SKILL.md",
  ".agents/skills/mavula-cloud-banking/agents/openai.yaml",
  ".agents/skills/mavula-cloud-banking/references/module-ownership.md",
  ".agents/skills/mavula-cloud-banking/references/banking-operations.md",
  ".agents/skills/mavula-cloud-banking/references/security-regulation.md",
  ".agents/skills/mavula-cloud-banking/references/cloud-native-scale.md",
  ".agents/skills/mavula-cloud-banking/references/composability-no-code.md",
  ".agents/skills/mavula-cloud-banking/references/engineering-data.md",
]);

export const canonicalAgentAdapters = Object.freeze([
  ".cursor/rules/mavula-engineering.mdc",
  ".github/copilot-instructions.md",
]);

export function enforceLocalAgentPolicy() {
  const failures = [];
  const required = [...canonicalAgentFiles, ...canonicalAgentAdapters];
  for (const file of required) {
    if (!existsSync(file)) failures.push(`${file} is required`);
  }

  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  if (tracked.status !== 0) return ["git ls-files failed for agent policy"];
  const trackedFiles = new Set(tracked.stdout.split("\n").filter(Boolean));

  for (const file of required) {
    if (!trackedFiles.has(file)) failures.push(`${file} must be tracked`);
  }

  const allowedAgents = new Set(canonicalAgentFiles);
  for (const file of trackedFiles) {
    if (file.startsWith(".agents/") && !allowedAgents.has(file)) {
      failures.push(`${file} is not part of the canonical agent policy`);
    }
    if (file.startsWith(".cursor/rules/") && file !== canonicalAgentAdapters[0]) {
      failures.push(`${file} is not part of the canonical Cursor policy`);
    }
  }

  for (const file of [
    ".agents/AGENTS.md",
    ".cursor/rules/mavula-engineering.mdc",
    ".github/copilot-instructions.md",
  ]) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const skill of ["mavula-review", "mavula-cloud-banking"]) {
      if (!content.includes(skill)) failures.push(`${file} must route to ${skill}`);
    }
  }

  return failures;
}
