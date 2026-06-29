const fs = require('fs');
const path = require('path');

const checkedDirs = ['src', 'test'].map((dir) => path.resolve(__dirname, '..', dir));
const consolePattern = /\bconsole\.(log|warn|error|info|debug|trace)\b/;
const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }

    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (consolePattern.test(line)) {
        violations.push(`${path.relative(process.cwd(), fullPath)}:${index + 1}`);
      }
    });
  }
}

for (const dir of checkedDirs) {
  if (fs.existsSync(dir)) {
    walk(dir);
  }
}

if (violations.length > 0) {
  console.error('console.* is not allowed in fengine source or tests:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
