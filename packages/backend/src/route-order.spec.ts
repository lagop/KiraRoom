import * as fs from "fs";
import * as path from "path";

/**
 * Express matches routes in declaration order. A literal path declared after
 * a parameter route of the same shape is unreachable: GET
 * /appointments/pending-payment matched GET /appointments/:id first, and
 * ParseUUIDPipe answered 400. Three such routes had been dead for as long as
 * they existed (appointments/pending-payment, invoices/certificates,
 * pos/products/categories), each behind a screen that failed quietly.
 *
 * This scans every controller class and fails on any literal route that an
 * earlier route of the same verb would capture.
 */

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) controllerFiles(full, out);
    else if (name.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

interface Route { verb: string; path: string }

/** Routes per controller class, in declaration order. */
function routesByController(source: string): Route[][] {
  const classes = source.split(/@Controller\(/).slice(1);
  return classes.map((body) => {
    const routes: Route[] = [];
    const re = /@(Get|Post|Put|Patch|Delete)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) routes.push({ verb: m[1], path: m[2] ?? "" });
    return routes;
  });
}

/** Would `earlier` capture every request meant for `later`? */
function shadows(earlier: Route, later: Route): boolean {
  if (earlier.verb !== later.verb) return false;
  const a = earlier.path.split("/").filter(Boolean);
  const b = later.path.split("/").filter(Boolean);
  if (a.length !== b.length || a.length === 0) return false;
  let usesParam = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) {
      if (!b[i].startsWith(":")) usesParam = true;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return usesParam;
}

describe("route declaration order", () => {
  const files = controllerFiles(path.resolve(__dirname));

  it("finds the controllers", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no literal route hidden behind an earlier parameter route", () => {
    const problems: string[] = [];
    for (const file of files) {
      for (const routes of routesByController(fs.readFileSync(file, "utf8"))) {
        routes.forEach((later, i) => {
          for (const earlier of routes.slice(0, i)) {
            if (shadows(earlier, later)) {
              problems.push(
                `${path.relative(__dirname, file)}: ${later.verb} "${later.path}" is captured by "${earlier.path}"`,
              );
            }
          }
        });
      }
    }
    expect(problems).toEqual([]);
  });
});
