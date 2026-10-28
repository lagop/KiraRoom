/**
 * No component reads the signed-in user while it renders.
 *
 * `getCurrentUser()` decodes the token in localStorage, which the server does
 * not have: there it returns null. The dashboard header did
 *
 *     const currentUser = useMemo(() => getCurrentUser(), []);
 *
 * so the server wrote "User" and the browser's first render wrote the email.
 * Every dashboard page then failed to hydrate (React #425, #418, #423 in a
 * production build) and was rendered again from scratch on the client. The
 * Copilot panel did the same with the role.
 *
 * Read it in a useEffect instead (see the header and the sidebar). This spec
 * flags a call in a component body: a `const x = getCurrentUser()` (or the
 * useMemo form) at the body's indentation.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/render-time-user.spec.ts
 */

import * as fs from "fs";
import * as path from "path";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, detail ?? "");
  }
}

// Two spaces: the body of a top-level component. Calls inside effects and
// handlers are indented further.
const IN_RENDER = /^ {2}(?:const|let) \w+ = (?:useMemo\(\(\) => )?getCurrentUser\(\)/;

function readsUserInRender(source: string): number[] {
  return source
    .split(/\r?\n/)
    .map((line, i) => (IN_RENDER.test(line) ? i + 1 : 0))
    .filter(Boolean);
}

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

check(
  "the old header line is caught",
  readsUserInRender("  const currentUser = useMemo(() => getCurrentUser(), []);").length === 1,
);
check(
  "so is a plain call in the body",
  readsUserInRender("  const user = getCurrentUser();").length === 1,
);
check(
  "a call inside an effect is fine",
  readsUserInRender("  useEffect(() => {\n    setCurrentUser(getCurrentUser());\n    const role = getCurrentUser()?.role;\n  }, []);").length === 0,
);

const root = path.join(__dirname, "..");
const offenders = ["app", "components", "src"]
  .flatMap((dir) => sourceFiles(path.join(root, dir)))
  .flatMap((file) =>
    readsUserInRender(fs.readFileSync(file, "utf8")).map(
      (line) => `${path.relative(root, file).split(path.sep).join("/")}:${line}`,
    ),
  );
check("no component reads the user while rendering", offenders.length === 0, offenders);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
