/**
 * The Content Security Policy every page sends (report-only for now).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only csp.spec.ts
 */
export {};

const { buildCsp, cspHeaders } = require("./csp");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

const API = "https://api.kiraroom.net/api/v1";
const prod = directives(buildCsp({ apiUrl: API }));

check("scripts only from the app (inline kept for Next.js)", prod["script-src"].join(" ") === "'self' 'unsafe-inline'", prod["script-src"]);
check("no eval in production", !prod["script-src"].includes("'unsafe-eval'"));
check(
  "connections only to the app and the API, including its WebSocket for live notifications",
  prod["connect-src"].join(" ") === "'self' https://api.kiraroom.net wss://api.kiraroom.net",
  prod["connect-src"],
);
check("no plugins", prod["object-src"][0] === "'none'");
check("no <base> hijacking", prod["base-uri"][0] === "'self'");
check("forms only to the app", prod["form-action"][0] === "'self'");
check("logos and QR images still load (https:, data:, blob:)", ["https:", "data:", "blob:"].every((v) => prod["img-src"].includes(v)));
check("violations reported to the API", prod["report-uri"]?.[0] === `${API}/csp-report` && prod["report-to"]?.[0] === "csp", prod);

const dev = directives(buildCsp({ apiUrl: "http://localhost:3001/api/v1", dev: true }));
check("next dev gets eval and its reload socket", dev["script-src"].includes("'unsafe-eval'") && dev["connect-src"].includes("ws:"), dev);

const headers = cspHeaders({ apiUrl: API });
check(
  "sent as Report-Only, so nothing breaks while the reports come in",
  headers[0].key === "Content-Security-Policy-Report-Only" && !headers.some((h: any) => h.key === "Content-Security-Policy"),
  headers,
);
check("with the Reporting-Endpoints header Chromium needs", headers[1]?.value === `csp="${API}/csp-report"`, headers);
check("a trailing slash in the API URL does not double up", buildCsp({ apiUrl: `${API}/` }).includes(`${API}/csp-report`));

// The production image copies next.config.js on its own (packages/frontend/Dockerfile),
// so every local file it requires must be copied too. csp.js was not, and the
// first deploy of this policy left the frontend container restarting.
{
  const fs = require("fs");
  const path = require("path");
  const config: string = fs.readFileSync(path.join(__dirname, "next.config.js"), "utf8");
  const dockerfile: string = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  const localRequires = [...config.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  check("next.config.js requires csp.js", localRequires.some((r) => r.replace(/\.js$/, "") === "csp"), localRequires);
  for (const r of localRequires) {
    const file = r.endsWith(".js") ? r : `${r}.js`;
    check(
      `the production image copies ${file}, which next.config.js requires`,
      dockerfile.includes(`/repo/packages/frontend/${file} ./${file}`),
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
