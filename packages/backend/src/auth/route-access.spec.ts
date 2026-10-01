import { readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "./decorators/public.decorator";
import { ROLES_KEY } from "./decorators/roles.decorator";
import { SIGNED_IN_KEY } from "./decorators/signed-in.decorator";
import { SAAS_OWNER_KEY } from "../saas/decorators/saas-owner.decorator";

/**
 * Every route says who it is for.
 *
 * RolesGuard refuses a route that declares nothing, so a forgotten
 * declaration shows up as a 403 in production. This catches it here
 * instead, and lists the routes so a reviewer sees what changed.
 */

/**
 * Webhooks that today require a session, which their senders never have.
 * They become @Public() once their signatures are verified (Stripe already
 * is; Resend is not). Until then they stay closed, as they are now.
 */
const PENDING = new Set([
  "payments/webhooks.controller.ts#handleStripeWebhook",
  "email-campaigns/resend-webhooks.controller.ts#handleResendWebhook",
]);

const KEYS = [IS_PUBLIC_KEY, ROLES_KEY, SIGNED_IN_KEY, SAAS_OWNER_KEY];

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith(".controller.ts") ? [path] : [];
  });
}

function undeclaredRoutes(): string[] {
  const missing: string[] = [];
  for (const file of controllerFiles(__dirname + "/..")) {
    const rel = relative(join(__dirname, ".."), file).split(sep).join("/");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exported = require(file);
    for (const cls of Object.values<any>(exported)) {
      if (typeof cls !== "function" || Reflect.getMetadata(PATH_METADATA, cls) === undefined) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (typeof handler !== "function" || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const declared = KEYS.some(
          (key) => Reflect.getMetadata(key, handler) !== undefined || Reflect.getMetadata(key, cls) !== undefined,
        );
        if (!declared && !PENDING.has(`${rel}#${name}`)) missing.push(`${rel}#${name}`);
      }
    }
  }
  return missing;
}

describe("route access", () => {
  it("every route declares @Public, @Roles, @SaasOwner or @SignedIn", () => {
    expect(undeclaredRoutes()).toEqual([]);
  }, 120_000);
});
