#!/usr/bin/env node
/**
 * KiraRoom → KiraRoom rename. Idempotent.
 *
 * Replaces (case-aware, in this order to avoid double-replacement):
 *   KiraRoom   → KiraRoom       (PascalCase product name)
 *   Kira Room  → Kira Room      (with-space form in prose)
 *   KIRA ROOM  → KIRA ROOM      (all-caps env vars / DB names)
 *   kiraroom   → kiraroom       (lowercase docker tags / POSTGRES_DB)
 *   kira-room  → kira-room      (kebab-case package names / docker images)
 *
 * Skipped (NOT renamed):
 *   @kira/*       — npm scope kept per scope decision (Q2)
 *   Studio26      — separate brand (the user's studio name)
 *   kira_room / KiraRoom / Kira Room — already-renamed idempotency
 *   /_backups/, /node_modules/, /dist/, /.next/, /coverage/ — gitignored
 *
 * Run from repo root:
 *   node scripts/rename-to-kiraroom.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

// Path-based ignore — these substrings in the absolute path mean
// "don't touch this file" (binary, generated, gitignored).
const IGNORE_PATH_SUBSTR = [
  path.sep + 'node_modules' + path.sep,
  path.sep + 'dist' + path.sep,
  path.sep + '.next' + path.sep,
  path.sep + '.nx' + path.sep,
  path.sep + 'coverage' + path.sep,
  path.sep + '_backups' + path.sep,
  path.sep + '.git' + path.sep,
  path.sep + '.kilo' + path.sep,
  path.sep + '.astro' + path.sep,
];

// File-extension ignore — binary files would get corrupted.
const IGNORE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz', '.7z',
  '.p12', '.pem', '.key', '.crt',
  '.mp3', '.mp4', '.wav',
  '.pdf', '.xlsx', '.docx', '.pptx',
  '.bin', '.exe', '.dll',
]);

// Strings we replace, in order. Replacements later in the list run
// against already-replaced text — important because "KiraRoom" must
// not be touched by a later "Kira" rule that would corrupt "KiraRoom".
const RULES = [
  // All-caps first so "KIRA ROOM" doesn't become "KiraRoom" mid-pipeline.
  { from: /KIRA ROOM/g, to: 'KIRA ROOM' },
  { from: /KiraRoom/g, to: 'KiraRoom' },
  { from: /Kira Room/g, to: 'Kira Room' },
  { from: /kiraroom/g, to: 'kiraroom' },
  { from: /kira-room/g, to: 'kira-room' },
];

function shouldIgnorePath(p) {
  const abs = path.resolve(p);
  return IGNORE_PATH_SUBSTR.some((sub) => abs.includes(sub));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (shouldIgnorePath(full)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORE_EXT.has(ext)) continue;
      out.push(full);
    }
  }
  return out;
}

function applyRules(text) {
  let next = text;
  for (const { from, to } of RULES) {
    next = next.replace(from, to);
  }
  return next;
}

const files = walk(ROOT);
let touched = 0;
let linesChanged = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const next = applyRules(text);
  if (next !== text) {
    fs.writeFileSync(f, next);
    touched++;
    // Count distinct lines changed.
    const oldLines = text.split('\n');
    const newLines = next.split('\n');
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) linesChanged++;
    }
  }
}
console.log(`Renamed in ${touched} files (${linesChanged} lines changed).`);
