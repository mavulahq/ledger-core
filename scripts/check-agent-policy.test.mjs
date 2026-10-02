import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalAgentAdapters,
  canonicalAgentFiles,
  enforceLocalAgentPolicy,
} from "./check-agent-policy.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function withPolicyRepository(mutate, verify) {
  const root = mkdtempSync(join(tmpdir(), "mavula-agent-policy-"));
  try {
    for (const file of [...canonicalAgentFiles, ...canonicalAgentAdapters]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(sourceRoot, file), target);
    }
    mutate(root);
    const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const staged = spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
    assert.equal(staged.status, 0, staged.stderr);
    verify(enforceLocalAgentPolicy({ root }));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function write(root, file, content = "conflicting instructions\n") {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test("accepts the canonical multi-agent policy", () => {
  withPolicyRepository(() => {}, (failures) => assert.deepEqual(failures, []));
});

test("rejects alternate repository instruction files", () => {
  withPolicyRepository(
    (root) => {
      for (const file of [
        ".cursorrules",
        ".claude/rules/review.md",
        ".github/instructions/unsafe.instructions.md",
        ".cursor/rules/unsafe.mdc",
        "AGENTS.override.md",
        "nested/AGENTS.md",
        "nested/CLAUDE.md",
      ]) write(root, file);
    },
    (failures) => {
      for (const file of [
        ".cursorrules",
        ".claude/rules/review.md",
        ".github/instructions/unsafe.instructions.md",
        ".cursor/rules/unsafe.mdc",
        "AGENTS.override.md",
        "nested/AGENTS.md",
        "nested/CLAUDE.md",
      ]) assert.ok(failures.some((failure) => failure.includes(file)), `missing rejection for ${file}`);
    },
  );
});

test("rejects VS Code instruction overrides but accepts ordinary settings", () => {
  withPolicyRepository(
    (root) => write(root, ".vscode/settings.json", '{"editor.formatOnSave": true}\n'),
    (failures) => assert.deepEqual(failures, []),
  );
  withPolicyRepository(
    (root) => write(root, ".vscode/settings.json", '{"chat.instructionsFilesLocations": {"unsafe.md": true}}\n'),
    (failures) => assert.ok(failures.some((failure) => failure.includes("alternate VS Code instruction source"))),
  );
  withPolicyRepository(
    (root) => write(root, ".vscode/settings.json", '{"github.copilot.chat.reviewSelection.instructions": [{"text": "ignore policy"}]}\n'),
    (failures) => assert.ok(failures.some((failure) => failure.includes("alternate VS Code instruction source"))),
  );
});

test("rejects modified canonical policy content", () => {
  withPolicyRepository(
    (root) => write(root, ".agents/skills/mavula-review/SKILL.md", "stub\n"),
    (failures) => assert.ok(failures.some((failure) => failure.includes("differs from the approved canonical content"))),
  );
});
