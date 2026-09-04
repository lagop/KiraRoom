#!/usr/bin/env tsx
/**
 * scripts/legal-sync.ts — enforce the single-source-of-truth for
 * legal text.
 *
 * The privacy + ToS pages live in two places:
 *   - `packages/frontend/app/legal/privacy/page.tsx` (canonical, used
 *     by the in-app pages)
 *   - `docs/privacy.md` (audit mirror, used by the marketing site
 *     and the GitHub repo)
 *
 * Both files carry a `⚠️ SOURCE OF TRUTH` warning pointing at the
 * other side. This script enforces that contract: it reads the .tsx
 * file, extracts the legal body, and overwrites the .md file. Run
 * it whenever you edit the .tsx file:
 *
 *   npx tsx scripts/legal-sync.ts
 *
 * Or wire it into a pre-commit hook so it can't be forgotten.
 *
 * The converter is intentionally minimal: it handles the JSX patterns
 * present in the current files (h2, p, strong/em/code, a, ul/ol/li,
 * block-level JSX expressions, fragment). Anything exotic in the
 * future will need a new branch — but a future edit + sync run will
 * surface the gap immediately because the .md will be empty / wrong.
 *
 * Exit codes:
 *   0 — success
 *   1 — a JSX pattern was encountered that the converter can't handle
 *   2 — a source file was missing or unreadable
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Source = { tsx: string; md: string; title: string; h1: string };

const SOURCES: Source[] = [
  {
    tsx: "packages/frontend/app/legal/privacy/page.tsx",
    md: "docs/privacy.md",
    title: "Política de Privacidad",
    h1: "Política de Privacidad",
  },
  {
    tsx: "packages/frontend/app/legal/terms/page.tsx",
    md: "docs/tos.md",
    title: "Términos del Servicio",
    h1: "Términos del Servicio",
  },
];

const ROOT = resolve(__dirname, "..");

function main(): void {
  let errors = 0;
  for (const src of SOURCES) {
    const tsxPath = resolve(ROOT, src.tsx);
    const mdPath = resolve(ROOT, src.md);
    let tsxContent: string;
    try {
      tsxContent = readFileSync(tsxPath, "utf8");
    } catch (err) {
      console.error(`✗ Cannot read ${src.tsx}: ${(err as Error).message}`);
      errors += 1;
      continue;
    }

    const body = extractLegalBody(tsxContent);
    if (!body) {
      console.error(`✗ Could not locate <main> body in ${src.tsx}`);
      errors += 1;
      continue;
    }

    const md = renderMarkdown(body, src);
    try {
      writeFileSync(mdPath, md, "utf8");
      console.log(`✓ ${src.md} ← ${src.tsx}`);
    } catch (err) {
      console.error(`✗ Cannot write ${src.md}: ${(err as Error).message}`);
      errors += 1;
    }
  }
  if (errors > 0) {
    console.error(`\n${errors} source(s) failed.`);
    process.exit(errors === 0 ? 0 : 1);
  }
}

interface Node {
  kind: "h2" | "h3" | "p" | "ul" | "ol" | "li" | "fragment";
  /**
   * For block nodes (h2/h3/p/li), the inline text after conversion.
   * For ul/ol, the list items. For fragment, the children.
   */
  children: (Node | string)[];
}

function extractLegalBody(tsx: string): Node | null {
  // Slice between `<main ...>` (the wrapper used by all three pages)
  // and its closing `</main>`. The body is everything inside.
  const openMatch = tsx.match(/<main\b[^>]*>/);
  if (!openMatch) return null;
  const start = openMatch.index! + openMatch[0].length;
  // Naive closing-tag search — pages don't nest <main>.
  const end = tsx.indexOf("</main>", start);
  if (end < 0) return null;
  const body = tsx.slice(start, end);
  return parseNodes(body);
}

function parseNodes(src: string): Node {
  // Top-level fragments: a sequence of <section>...</section> blocks
  // (each privacy/terms page wraps sections this way) plus bare
  // <p> / <h2> / <h3>.
  const items: (Node | string)[] = [];
  let cursor = 0;
  while (cursor < src.length) {
    // Skip whitespace between blocks
    const ws = src.slice(cursor).match(/^\s+/);
    if (ws) {
      cursor += ws[0].length;
      continue;
    }
    const next = src.slice(cursor).match(/^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/);
    if (!next) {
      // Bare text — unlikely but harmless
      const text = src.slice(cursor).trim();
      if (text) items.push(text);
      break;
    }
    const isClose = next[1] === "/";
    const tag = next[2];
    const attrs = next[3];

    if (isClose) {
      // Stray closing tag at the top level — skip
      cursor += next[0].length;
      continue;
    }

    if (tag === "section") {
      const inner = readUntilMatchingClose(src, cursor + next[0].length, "section");
      if (!inner) {
        console.error(`✗ Unmatched <section> at offset ${cursor}`);
        process.exit(1);
      }
      // The <section> body may contain h2 + p + ul + nested JSX. Wrap
      // its content in a fragment-like node we can flatten later.
      items.push({ kind: "fragment", children: parseNodes(inner).children });
      cursor += next[0].length + inner.length + "</section>".length;
      continue;
    }

    // For block tags we self-close only when the tag is `<br/>` or
    // `<hr/>`. Everything else needs an explicit close.
    if (attrs.endsWith("/")) {
      // Self-closing — emit an empty inline marker.
      items.push(`<${tag}/>`);
      cursor += next[0].length;
      continue;
    }

    const inner = readUntilMatchingClose(src, cursor + next[0].length, tag);
    if (inner === null) {
      console.error(`✗ Unmatched <${tag}> at offset ${cursor}`);
      process.exit(1);
    }
    const rendered = convertInline(inner);
    switch (tag) {
      case "h2":
        items.push({ kind: "h2", children: [rendered] });
        break;
      case "h3":
        items.push({ kind: "h3", children: [rendered] });
        break;
      case "p":
        items.push({ kind: "p", children: [rendered] });
        break;
      case "ul":
        items.push({ kind: "ul", children: parseListItems(inner, "ul") });
        break;
      case "ol":
        items.push({ kind: "ol", children: parseListItems(inner, "ol") });
        break;
      case "div":
      case "main":
        // The in-app pages wrap content in a <main> + <div>. We've
        // already handled <main>; <div> is a no-op container — recurse.
        items.push(...parseNodes(inner).children);
        break;
      default:
        console.error(
          `✗ Unsupported block tag <${tag}> at offset ${cursor}. ` +
            `Extend legal-sync.ts to handle it.`,
        );
        process.exit(1);
    }
    cursor += next[0].length + inner.length + `</${tag}>`.length;
  }
  return { kind: "fragment", children: items };
}

function parseListItems(src: string, _tag: "ul" | "ol"): Node[] {
  const items: Node[] = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(src))) {
    items.push({ kind: "li", children: [convertInline(m[1])] });
  }
  return items;
}

/**
 * Convert the inline content of an element. Replaces `<strong>` →
 * `**…**`, `<em>` → `*…*`, `<code>` → `\`…\``, `<a href="…">label</a>`
 * → `[label](href)`. JSX expressions like `{something}` are stripped
 * (the in-app pages reference things like `<strong>{data.tenantName}</strong>`
 * which we can't resolve without the runtime, but the .md is a flat
 * copy for auditors — those interpolations are intentionally absent).
 */
function convertInline(src: string): string {
  return src
    // Drop block-level JSX expressions — they're always simple
    // interpolations in the legal pages (e.g. `{updated}`).
    .replace(/\{[^}]+\}/g, "")
    .replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**")
    .replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
    .replace(/<br\s*\/?>/g, "  \n")
    // Collapse whitespace inside the inline string but preserve the
    // trailing newline before the next block.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the matching close tag for an open tag at `from`. Handles
 * nested same-name tags. Returns the substring *inside* the matching
 * pair, or `null` if no match is found.
 */
function readUntilMatchingClose(src: string, from: number, tag: string): string | null {
  let depth = 1;
  let cursor = from;
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "g");
  const closeRe = new RegExp(`</${tag}>`, "g");
  while (depth > 0 && cursor < src.length) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(src);
    const nextClose = closeRe.exec(src);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return src.slice(from, nextClose.index);
      }
    }
  }
  return null;
}

function renderMarkdown(body: Node, src: Source): string {
  const out: string[] = [];
  // Header — mirrors the docs/privacy.md / docs/tos.md hand-written
  // structure. The ⚠️ SOURCE OF TRUTH warning is intentionally kept:
  // it's the only thing in the .md that the script doesn't regenerate.
  const sourceRelative = src.tsx
    .replace(/^packages\//, "../")
    .replace(/^docs\//, "./");
  out.push(`# ${src.h1} — KiraStudio`);
  out.push("");
  out.push(
    `> ⚠️ **SOURCE OF TRUTH**: Este fichero **NO** se edita a mano. La versión canónica es la página React en \`${sourceRelative}\`. Si necesitas cambiar el texto, edita esa página y regenera este markdown con \`npx tsx scripts/legal-sync.ts\`.`,
  );
  out.push("");
  out.push(`> Última actualización: 17 de julio de 2026.`);
  out.push("");
  out.push(
    `> *Modelo adaptado de las plantillas y orientaciones publicadas por la Agencia Española de Protección de Datos (AEPD) en [aepd.es](https://www.aepd.es/es/areas-de-actuacion/internet-y-redes-sociales/modelos-de-politica-de-privacidad) y de la Guía del RGPD de la AEPD para PYMEs. Esta política cumple el deber de información del **Art. 13 del RGPD** y se completa con la [Política de Privacidad](privacy.md) y la información sobre cookies que se muestra en el banner de consentimiento.*`,
  );
  out.push("");

  for (const node of flatten(body)) {
    if (typeof node === "string") {
      if (node.trim().length > 0) out.push(node.trim());
      continue;
    }
    switch (node.kind) {
      case "h2":
        out.push(`## ${inlineText(node)}`, "");
        break;
      case "h3":
        out.push(`### ${inlineText(node)}`, "");
        break;
      case "p":
        out.push(`${inlineText(node)}`, "");
        break;
      case "ul":
      case "ol":
        for (const item of node.children) {
          if (typeof item === "string") continue;
          out.push(`- ${inlineText(item)}`);
        }
        out.push("");
        break;
      case "li":
        out.push(`- ${inlineText(node)}`);
        break;
      case "fragment":
        for (const c of node.children) out.push(...wrap(c));
        break;
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function inlineText(node: Node): string {
  return node.children
    .map((c) => (typeof c === "string" ? c : inlineText(c)))
    .join("");
}

function* flatten(node: Node): Generator<Node | string> {
  for (const child of node.children) {
    if (typeof child === "string") {
      yield child;
    } else if (child.kind === "fragment") {
      yield* flatten(child);
    } else {
      yield child;
    }
  }
}

function wrap(s: string | Node): string[] {
  return typeof s === "string" ? [s] : [];
}

main();