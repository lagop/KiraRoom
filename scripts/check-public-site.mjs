#!/usr/bin/env node
/**
 * Weekly check of the public website (audit 9, T4/M3).
 *
 * kiraroom.com is a static site published from a different, private
 * repository, so nothing in this repo's CI sees it. This script downloads
 * the live page and fails, with a list, if:
 *
 *   - it still contains "hola@" or "IVA no incluido";
 *   - a mailto: address is not one of the two real mailboxes;
 *   - a link does not end in a 200 (anchors "#x" must match an id on the page);
 *   - the plan prices, the professionals per plan or the AI messages per plan
 *     differ from the catalogue in packages/shared/src/types/subscription.ts.
 *
 * Plain node (18 or newer), no dependencies, no network except the site.
 * It is NOT part of CI because it needs the network.
 *
 *   node scripts/check-public-site.mjs                  # https://kiraroom.com/
 *   node scripts/check-public-site.mjs https://staging.example.com/
 *   node scripts/check-public-site.mjs --html page.html # a saved copy; links are not fetched
 *
 * Exit code: 0 all good, 1 problems found, 2 the page could not be read.
 * See docs/website.md.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = resolve(ROOT, "packages/shared/src/types/subscription.ts");
const DEFAULT_URL = "https://kiraroom.com/";

/** The only mailboxes that exist (info@ public, admin@ internal). */
const ALLOWED_MAILBOXES = new Set(["info@kiraroom.com", "admin@kiraroom.net"]);
/** Text that must not come back. [pattern, why]. */
const FORBIDDEN = [
  [/hola@/i, "the address hola@ does not exist (use info@kiraroom.com)"],
  [/IVA\s+no\s+incluido/i, '"IVA no incluido": prices carry no tax on top (terms: final price)'],
];
const LINK_TIMEOUT_MS = 15_000;

/** { esencial: 49, ... } from `export const NAME ... = { key: value, ... };` in the catalogue file. */
export function readCatalogMap(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in ${CATALOG}`);
  const open = source.indexOf("= {", start);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error(`${name}: cannot find its object literal`);
  const out = {};
  for (const m of source.slice(open + 3, close).matchAll(/(\w+)\s*:\s*(null|\d+)/g)) {
    out[m[1]] = m[2] === "null" ? null : Number(m[2]);
  }
  return out;
}

/** 2000 -> "2.000" (how the page writes it). */
const es = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** The plan cards: { esencial: { price: 49, professionals: 4 | null } }. */
export function readPublishedPlans(html) {
  const plans = {};
  for (const chunk of html.split(/<article class="plan\b/).slice(1)) {
    const name = /class="plan-name">\s*([^<]+?)\s*</.exec(chunk)?.[1];
    if (!name) continue;
    const price = /class="num">\s*(\d+)\s*</.exec(chunk)?.[1];
    const note = /class="price-note">([^<]*)</.exec(chunk)?.[1] ?? "";
    const pros = /hasta\s+(\d+)\s+profesionales/i.exec(note)?.[1];
    plans[name.toLowerCase()] = {
      price: price ? Number(price) : null,
      professionals: pros ? Number(pros) : /ilimitad/i.test(note) ? null : undefined,
    };
  }
  return plans;
}

export function checkContent(html, catalog) {
  const problems = [];

  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(html)) problems.push(`forbidden text ${pattern}: ${why}`);
  }

  const mailtos = new Set(
    [...html.matchAll(/href="mailto:([^"?]+)/gi)].map((m) => decodeURIComponent(m[1]).trim().toLowerCase()),
  );
  for (const address of mailtos) {
    if (!ALLOWED_MAILBOXES.has(address)) problems.push(`mailto to an address that is not a real mailbox: ${address}`);
  }

  const published = readPublishedPlans(html);
  for (const [plan, price] of Object.entries(catalog.prices)) {
    const card = published[plan];
    if (!card) {
      problems.push(`plan "${plan}" is not on the page`);
      continue;
    }
    if (card.price !== price) problems.push(`plan "${plan}": the page says ${card.price} EUR, the catalogue ${price} EUR`);
    const pros = catalog.professionals[plan];
    if (card.professionals === undefined) problems.push(`plan "${plan}": the page does not say how many professionals`);
    else if (card.professionals !== pros) {
      problems.push(`plan "${plan}": the page says ${card.professionals ?? "unlimited"} professionals, the catalogue ${pros ?? "unlimited"}`);
    }
    // The calculator buttons ("Esencial · 49 €") say the price again.
    const label = plan.charAt(0).toUpperCase() + plan.slice(1);
    const button = new RegExp(`${label}\\s*·\\s*(\\d+)\\s*€`).exec(html);
    if (button && Number(button[1]) !== price) {
      problems.push(`calculator button "${label}" says ${button[1]} EUR, the catalogue ${price} EUR`);
    }
  }
  for (const [plan, messages] of Object.entries(catalog.aiMessages)) {
    const n = es(messages);
    if (!new RegExp(`${n}\\s*mensajes|\\(${n}\\)`).test(html)) {
      problems.push(`plan "${plan}": the page never mentions ${n} AI messages a month (the catalogue's cap)`);
    }
  }

  return problems;
}

function pageLinks(html, base) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const urls = new Set();
  const anchors = new Set();
  for (const m of html.matchAll(/<a\s[^>]*?href="([^"]*)"/gi)) {
    const href = m[1].trim().replace(/&amp;/g, "&");
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (href.startsWith("#")) {
      if (href.length > 1) anchors.add(href.slice(1));
      continue;
    }
    try {
      const u = new URL(href, base);
      u.hash = "";
      urls.add(u.href);
    } catch {
      urls.add(href);
    }
  }
  return { urls: [...urls], missingAnchors: [...anchors].filter((a) => !ids.has(a)) };
}

async function status(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch (err) {
    return `no answer (${err?.cause?.code ?? err?.name ?? "error"})`;
  }
}

export async function checkLinks(html, base) {
  const { urls, missingAnchors } = pageLinks(html, base);
  const problems = missingAnchors.map((a) => `link to #${a}, but nothing on the page has that id`);
  const results = await Promise.all(urls.map(async (u) => [u, await status(u)]));
  for (const [u, s] of results) if (s !== 200) problems.push(`link ${u} answers ${s}, not 200`);
  return { problems, checked: urls.length };
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--html");
  const offline = fileIdx >= 0;
  const url = (offline ? null : args.find((a) => !a.startsWith("--"))) ?? DEFAULT_URL;

  let html;
  try {
    if (offline) html = readFileSync(args[fileIdx + 1], "utf8");
    else {
      const res = await fetch(url, { signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
      if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
      html = await res.text();
    }
  } catch (err) {
    console.error(`Could not read the page: ${err.message}`);
    process.exit(2);
  }

  const source = readFileSync(CATALOG, "utf8");
  const catalog = {
    prices: readCatalogMap(source, "PLAN_PRICES"),
    professionals: readCatalogMap(source, "PLAN_MAX_PROFESSIONALS"),
    aiMessages: readCatalogMap(source, "PLAN_AI_CONVERSATIONS"),
  };

  const problems = checkContent(html, catalog);
  let note = "links not fetched (offline copy)";
  if (!offline) {
    const links = await checkLinks(html, url);
    problems.push(...links.problems);
    note = `${links.checked} links fetched`;
  }

  if (problems.length > 0) {
    console.error(`${offline ? args[fileIdx + 1] : url}: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK: ${offline ? args[fileIdx + 1] : url} matches the catalogue (${Object.keys(catalog.prices).join(", ")}; ${note}).`);
}

// Run only when called as a script, so the checks can be imported and tried.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
