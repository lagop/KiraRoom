#!/usr/bin/env node
/**
 * Cleanup: remove `ParseUUIDPipe` from the import statement of any
 * controller that doesn't actually use `@Param("id", ParseUUIDPipe)`.
 * The SEC-2 mass-edit script injected the import everywhere; that's
 * only needed where the pipe is actually applied.
 */
const fs = require('fs');
const path = require('path');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function stripUnused(text) {
  if (!/@Param\s*\(\s*["']id["']\s*,\s*ParseUUIDPipe/.test(text)) {
    // No actual usage — strip the import.
    let next = text;
    // Multi-name import: 'A, ParseUUIDPipe, B' → 'A, B'
    next = next.replace(/(\{\s*[^}]*?),\s*ParseUUIDPipe\s*,?/g, '$1,');
    next = next.replace(/,\s*\}/g, ' }');
    next = next.replace(/ParseUUIDPipe\s*,\s*/g, '');
    next = next.replace(/,\s*ParseUUIDPipe/g, '');
    // Standalone import line
    next = next.replace(/^import\s*\{\s*ParseUUIDPipe\s*\}\s*from\s*['"]@nestjs\/common['"];?\s*\n/m, '');
    // Empty import block (after the multi-name strip removed everything)
    next = next.replace(/import\s*\{\s*\}\s*from\s*['"]@nestjs\/common['"];?\s*\n/g, '');
    return next !== text ? next : null;
  }
  return null;
}

const files = walk('packages/backend/src');
let fixed = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (!text.includes('ParseUUIDPipe')) continue;
  const next = stripUnused(text);
  if (next !== null) {
    fs.writeFileSync(f, next);
    fixed++;
    console.log('Cleaned: ' + f);
  }
}
console.log('Cleaned ' + fixed + ' files.');
