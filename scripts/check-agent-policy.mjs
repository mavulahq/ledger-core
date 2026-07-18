import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const canonicalAgentFiles = Object.freeze([
  "AGENTS.md",
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
  "CLAUDE.md",
]);

export const canonicalAgentDigests = Object.freeze({
  "AGENTS.md": "8ea1de953a05a947f0cbe5a05ea0c5d4d98ef5fa5121611cc319cad5fcec2a86",
  ".agents/skills/mavula-review/SKILL.md": "225491092735e63ae996ee56ea550ca8a3385688b577a34c1ca3346ae32fd8f1",
  ".agents/skills/mavula-review/agents/openai.yaml": "8d9e7ded6558f9c57032d4654385fcf889911dbec3108c736d377ff31b536b1a",
  ".agents/skills/mavula-cloud-banking/SKILL.md": "610a2f2154839389aa67c550c17cde9f72296b012f2e89006937bf64c41ef355",
  ".agents/skills/mavula-cloud-banking/agents/openai.yaml": "0eceb6e2d4ce0ee09754bea0cb3ce71a96c22a2f1c3a62202c1561be0f1bcefd",
  ".agents/skills/mavula-cloud-banking/references/banking-operations.md": "000f033ca5810368513c0e53812ee9ee489565cb7b6c6589cce6ddb21748e39f",
  ".agents/skills/mavula-cloud-banking/references/cloud-native-scale.md": "54ff285d608844090883d2535988980fe84f398a6654c1e5ba1cfa52bccecb1a",
  ".agents/skills/mavula-cloud-banking/references/composability-no-code.md": "2a05a498b1145c13dd77f83746fab906fae7dacaa8f177e30a8b537e805bff6c",
  ".agents/skills/mavula-cloud-banking/references/engineering-data.md": "1f8ead9ddd44a67e4c5db465ad1da4f15495dc40d8c079ca88737683fe372534",
  ".agents/skills/mavula-cloud-banking/references/module-ownership.md": "b8f1f85b54e1b0878912e76d377c9b1484c7a685ee6299344429e4b7d8c67eb9",
  ".agents/skills/mavula-cloud-banking/references/security-regulation.md": "7f6ed9f897b1b6acf98e29687f4744da8fbdf21edfef8f75f217f938edb7bb20",
  ".cursor/rules/mavula-engineering.mdc": "5808eae2c61ed71c9986f238a8df46a2dd5d47fdb144dfdb5d1ab59e8845a736",
  ".github/copilot-instructions.md": "e559442e010dd5baf747999f51e828bf9224c4a990cb83c0322f99986cbe87e1",
  "CLAUDE.md": "b450943d31e250744342e8162d2418883ce8f3792a863e5d3353ef94f7c2fd13",
});

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function enforceLocalAgentPolicy({ root = "." } = {}) {
  const failures = [];
  const required = [...canonicalAgentFiles, ...canonicalAgentAdapters];
  for (const file of required) {
    if (!existsSync(join(root, file))) failures.push(`${file} is required`);
  }

  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) return ["git ls-files failed for agent policy"];
  const trackedFiles = new Set(tracked.stdout.split("\n").filter(Boolean));

  for (const file of required) {
    if (!trackedFiles.has(file)) failures.push(`${file} must be tracked`);
    const absolutePath = join(root, file);
    if (!existsSync(absolutePath)) continue;
    const expectedDigest = canonicalAgentDigests[file];
    if (!expectedDigest) {
      failures.push(`${file} has no approved canonical digest`);
    } else if (sha256(absolutePath) !== expectedDigest) {
      failures.push(`${file} differs from the approved canonical content`);
    }
  }

  const allowedAgents = new Set(canonicalAgentFiles);
  for (const file of trackedFiles) {
    if (file === ".cursorrules") {
      failures.push(`${file} conflicts with the canonical Cursor policy`);
    }
    if (file.startsWith(".agents/") && !allowedAgents.has(file)) {
      failures.push(`${file} is not part of the canonical agent policy`);
    }
    if (file.startsWith(".cursor/rules/") && file !== canonicalAgentAdapters[0]) {
      failures.push(`${file} is not part of the canonical Cursor policy`);
    }
    if (file.startsWith(".github/instructions/")) {
      failures.push(`${file} is not part of the canonical Copilot policy`);
    }
    if (file.startsWith(".claude/")) {
      failures.push(`${file} conflicts with the canonical Claude policy`);
    }
    const basename = file.split("/").at(-1);
    if (
      (["AGENTS.md", "AGENTS.override.md"].includes(basename) && file !== "AGENTS.md")
      || (basename === "CLAUDE.md" && file !== "CLAUDE.md")
    ) {
      failures.push(`${file} conflicts with the root agent entry point`);
    }
    if (file === ".vscode/settings.json") {
      const settings = readFileSync(join(root, file), "utf8");
      if (/"(?:chat\.instructionsFilesLocations|github\.copilot\.chat\.[^"]*\.instructions)"\s*:/.test(settings)) {
        failures.push(`${file} contains an alternate VS Code instruction source`);
      }
    }
  }

  for (const file of [
    "AGENTS.md",
    ".cursor/rules/mavula-engineering.mdc",
    ".github/copilot-instructions.md",
    "CLAUDE.md",
  ]) {
    const absolutePath = join(root, file);
    if (!existsSync(absolutePath)) continue;
    const content = readFileSync(absolutePath, "utf8");
    for (const skill of ["mavula-review", "mavula-cloud-banking"]) {
      if (!content.includes(skill)) failures.push(`${file} must route to ${skill}`);
    }
  }

  return failures;
}
