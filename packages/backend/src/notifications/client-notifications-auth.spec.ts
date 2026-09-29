import { GUARDS_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ClientNotificationsController } from "./client-notifications.controller";

/**
 * Every client-notification route was @Public() and took the client from a
 * `?clientId=` query: knowing a client's id was enough to read their
 * notifications, archive them and rewrite their preferences. The client now
 * comes from their own token.
 */

const proto = ClientNotificationsController.prototype as any;
const HANDLERS = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== "constructor" && typeof proto[name] === "function",
);

describe("client notifications require the client's own token", () => {
  it("guards the whole controller", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ClientNotificationsController);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("has no public route left", () => {
    expect(HANDLERS.length).toBeGreaterThan(0);
    for (const name of HANDLERS) {
      expect({ name, public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[name]) ?? false }).toEqual({
        name,
        public: false,
      });
    }
  });

  it("acts on the token's client, not on a client id the caller supplies", async () => {
    const seen: unknown[][] = [];
    const service = new Proxy({}, {
      get: () => async (...args: unknown[]) => { seen.push(args); return { data: [] }; },
    });
    const controller = new ClientNotificationsController(service as any);
    const me = { id: "client-me", tenantId: "tenant-a" };

    await controller.getUnreadCountForClient(me as any);
    await controller.getPreferencesForClient(me as any);
    await controller.updatePreferencesForClient(me as any, {} as any);

    expect(seen[0]).toEqual(["client-me"]);
    expect(seen[1]).toEqual(["client-me"]);
    expect(seen[2].slice(0, 2)).toEqual(["client-me", "tenant-a"]);
  });
});
