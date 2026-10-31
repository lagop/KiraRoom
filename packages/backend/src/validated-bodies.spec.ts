import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { ROUTE_ARGS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { getMetadataStorage } from "class-validator";

/**
 * The global ValidationPipe (main.ts, whitelist) validates and strips a
 * body only when its parameter type is a class with class-validator
 * decorators. An interface, an inline `{ ... }` type, `any`, `Record`, a
 * type alias (zod's `z.infer` included) all reach the pipe as `Object` and
 * pass through untouched. `PATCH /appointments/:id` typed its body with an
 * interface and spread it into a Prisma update: nested writes let any user
 * raise their own role. Commissions, promotions and the till had the same
 * shape (the till also took each line's price from the client).
 *
 * This loads every controller and fails on any `@Body()` whose declared
 * type is not such a class, so the next one is caught in review.
 */

/**
 * Bodies that are legitimately free-form: third-party payloads, each
 * authenticated before it is read (signature or shared secret), and the
 * browser's CSP reports (a log sink, 64 KB cap, throttled).
 */
const ALLOWED_UNVALIDATED = new Set([
  "WebhooksController.handleTwilioWebhook", // X-Twilio-Signature
  "WebhooksController.handleStripeWebhook", // stripe-signature over the raw body
  "MetaWebhookController.handle", // x-hub-signature-256 over the raw body
  "ChannelsWebhookController.handleMeta", // x-hub-signature-256 over the raw body
  "ChannelsWebhookController.handleTelegram", // per-tenant secret token header
  "CspReportController.receive", // report sink, parsed defensively
]);

/**
 * Being reworked on another branch at the time of writing; remove an entry
 * once its bodies are classes.
 */
const PENDING_DIRS = ["appointments", "assistant"];

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) controllerFiles(full, out);
    else if (name.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

interface BodyParam {
  handler: string;
  file: string;
  type: unknown;
}

function bodyParams(): BodyParam[] {
  const root = path.resolve(__dirname);
  const out: BodyParam[] = [];
  for (const file of controllerFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (PENDING_DIRS.some((d) => rel.startsWith(`${d}/`))) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values<any>(mod)) {
      if (typeof exported !== "function" || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      for (const method of Object.getOwnPropertyNames(exported.prototype)) {
        const args: Record<string, { index: number }> = Reflect.getMetadata(ROUTE_ARGS_METADATA, exported, method) ?? {};
        for (const [key, arg] of Object.entries(args)) {
          if (key.split(":")[0] !== String(RouteParamtypes.BODY)) continue;
          const types: unknown[] = Reflect.getMetadata("design:paramtypes", exported.prototype, method) ?? [];
          out.push({ handler: `${exported.name}.${method}`, file: rel, type: types[arg.index] });
        }
      }
    }
  }
  return out;
}

const PLAIN = new Set<unknown>([undefined, Object, String, Number, Boolean, Array]);

function isValidatedClass(type: unknown): boolean {
  if (PLAIN.has(type) || typeof type !== "function") return false;
  return getMetadataStorage().getTargetValidationMetadatas(type as any, "", true, false).length > 0;
}

describe("every @Body() is a validated class", () => {
  // Loaded while collecting, not inside a test: requiring ~60 controllers
  // takes longer than Jest's per-test timeout on a busy machine.
  const params = bodyParams();

  it("finds the controllers' bodies", () => {
    expect(params.length).toBeGreaterThan(100);
  });

  it("has no body typed with an interface, inline type, alias or any", () => {
    const unvalidated = params
      .filter((p) => !ALLOWED_UNVALIDATED.has(p.handler) && !isValidatedClass(p.type))
      .map((p) => `${p.file}: ${p.handler} (${(p.type as any)?.name ?? "unknown"})`);
    expect(unvalidated).toEqual([]);
  });

  it("keeps the allow-list honest: each entry is still an unvalidated body", () => {
    const seen = new Map(params.map((p) => [p.handler, p.type]));
    for (const handler of ALLOWED_UNVALIDATED) {
      expect(seen.has(handler)).toBe(true);
      expect(isValidatedClass(seen.get(handler))).toBe(false);
    }
  });
});
