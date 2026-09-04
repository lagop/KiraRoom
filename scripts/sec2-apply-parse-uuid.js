#!/usr/bin/env node
/**
 * SEC-2: apply ParseUUIDPipe to every @Param("id") id: string (and 'id')
 * declaration across backend controllers.
 *
 * Skips `invoices.controller.ts` (already done in the original review).
 *
 * Run from the repo root:
 *   node scripts/sec2-apply-parse-uuid.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'packages/backend/src';

// Recursively find every *.controller.ts except invoices.controller.ts
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      if (entry.name === 'invoices.controller.ts') continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Inject `ParseUUIDPipe` into the existing `@nestjs/common` import.
 * Handles three shapes:
 *   import { X, Y } from "@nestjs/common";      → add ParseUUIDPipe to the brace list
 *   import {} from "@nestjs/common";             → put ParseUUIDPipe in the brace list
 *   import "@nestjs/common";                      → expand to a named import
 */
function injectImport(text) {
  if (text.includes('ParseUUIDPipe')) return text;

  const namedMulti = /import\s*\{\s*([^}]*)\s*\}\s*from\s*(['"])@nestjs\/common\2;?/;
  const namedEmpty = /import\s*\{\s*\}\s*from\s*(['"])@nestjs\/common\2;?/;
  const bareImport = /import\s*(['"])@nestjs\/common\1;?/;

  if (namedMulti.test(text)) {
    return text.replace(namedMulti, (m, names) => {
      const list = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.includes('ParseUUIDPipe')) return m;
      list.unshift('ParseUUIDPipe');
      return `import { ${list.join(', ')} } from "@nestjs/common";`;
    });
  }
  if (namedEmpty.test(text)) {
    return text.replace(namedEmpty, 'import { ParseUUIDPipe } from "@nestjs/common";');
  }
  if (bareImport.test(text)) {
    return text.replace(bareImport, 'import { ParseUUIDPipe } from "@nestjs/common";');
  }
  // No @nestjs/common import at all — uncommon but possible if the
  // controller only uses pipe metaparameters via other mechanisms.
  return text;
}

function transform(text) {
  const original = text;
  text = injectImport(text);

  // @Param("id") id: string  →  @Param("id", ParseUUIDPipe) id: string
  text = text.replace(
    /@Param\(\s*"id"\s*\)\s+id\s*:\s*string\b/g,
    '@Param("id", ParseUUIDPipe) id: string',
  );
  // @Param('id') id: string
  text = text.replace(
    /@Param\(\s*'id'\s*\)\s+id\s*:\s*string\b/g,
    "@Param('id', ParseUUIDPipe) id: string",
  );

  return { text, changed: text !== original };
}

const files = walk(ROOT);
let touched = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const { text: next, changed } = transform(text);
  if (changed) {
    fs.writeFileSync(f, next);
    touched++;
    console.log('  ' + f);
  }
}
console.log(`Modified ${touched} controller(s).`);
