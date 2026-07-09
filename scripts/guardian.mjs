#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(path, "utf8");
}

function json(path) {
  return JSON.parse(read(path));
}

function requireFile(path) {
  if (!existsSync(path)) fail(`${path} is required`);
}

function requireText(path, pattern, message) {
  if (!pattern.test(read(path))) fail(message);
}

const pkg = json("package.json");

if (pkg.name !== "@mavula/ledger-core") fail("package name must be @mavula/ledger-core");
if (pkg.license !== "AGPL-3.0-only") fail("ledger-core must remain AGPL-3.0-only");
if (pkg.author !== "EstandarMustaq <estandarmustaq@mavula.io>") {
  fail("author must use the MAVULA address");
}

[
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/workflows/guardian.yml",
  "LICENSE",
  "README.md",
  "prisma/schema.prisma",
  "scripts/check-no-console.js",
].forEach(requireFile);

requireText("LICENSE", /SPDX-License-Identifier: AGPL-3\.0-only/, "LICENSE must declare AGPL SPDX");
requireText("README.md", /@mavula\/ledger-core/, "README must identify @mavula/ledger-core");

const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8" });
if (tracked.status !== 0) fail("git ls-files failed");
for (const file of tracked.stdout.split("\n").filter(Boolean)) {
  if (/(^|\/)\.env($|\.(?!example$))/.test(file)) fail(`${file} must not be tracked`);
}

for (const path of ["package.json", "README.md", ".github/CODEOWNERS"]) {
  if (path === "scripts/guardian.mjs") continue;
  const content = read(path);
  if (/getfluxo-io|@getfluxo|packages\/fengine|packages\/fwk|packages\/fpay|packages\/finfra/.test(content)) {
    fail(`${path} contains legacy public identifiers`);
  }
}

if (failures.length > 0) {
  console.error("MAVULA ledger-core guardian failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("MAVULA ledger-core guardian passed.");
