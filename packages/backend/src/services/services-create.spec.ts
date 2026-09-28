import { ServicesController } from "./services.controller";
import { ServicesService } from "./services.service";

/**
 * Creating a service takes the tenant from the caller's token.
 *
 * Every dashboard screen except the onboarding wizard sent a placeholder
 * tenantId ('demo-tenant', 'default-tenant', '1'). The tenant scope rejects a
 * write for a tenant other than the caller's, so those screens answered 403
 * and a salon could not add a service after onboarding.
 */

function prismaSpy() {
  const calls: any[] = [];
  const prisma = {
    service: {
      create: async (args: any) => {
        calls.push(args);
        return { id: "svc-1", ...args.data };
      },
    },
  };
  return { prisma, calls };
}

const OWNER = { id: "user-1", tenantId: "tenant-real", role: "owner" };
const BODY = { name: "Corte", category: "hair", duration: 30, price: 20 };

describe("POST /services", () => {
  it("creates the service in the caller's tenant", async () => {
    const { prisma, calls } = prismaSpy();
    const marked: string[] = [];
    const controller = new ServicesController(
      new ServicesService(prisma as any),
      { markStepCompleted: async (t: string) => { marked.push(t); } } as any,
    );

    await controller.create(OWNER, { ...BODY } as any);

    expect(calls[0].data.tenantId).toBe("tenant-real");
    expect(marked).toEqual(["tenant-real"]);
  });

  it("ignores a tenantId in the body", async () => {
    // The ValidationPipe whitelist strips it in production; this pins that
    // the controller would not use it even if it got through.
    const { prisma, calls } = prismaSpy();
    const controller = new ServicesController(
      new ServicesService(prisma as any),
      { markStepCompleted: async () => undefined } as any,
    );

    await controller.create(OWNER, { ...BODY, tenantId: "demo-tenant" } as any);

    expect(calls[0].data.tenantId).toBe("tenant-real");
  });
});

describe("service defaults", () => {
  async function created(overrides: Record<string, unknown>) {
    const { prisma, calls } = prismaSpy();
    await new ServicesService(prisma as any).create("tenant-real", { ...BODY, ...overrides } as any);
    return calls[0].data;
  }

  it("honours an explicit false", async () => {
    // `isActive || true` could never be false.
    const data = await created({ isActive: false, isOnlineBookable: false });
    expect(data.isActive).toBe(false);
    expect(data.isOnlineBookable).toBe(false);
  });

  it("honours an explicit zero", async () => {
    // `bufferTime || 15` turned a salon's "no buffer" into 15 minutes.
    const data = await created({ bufferTime: 0, minAdvanceBooking: 0 });
    expect(data.bufferTime).toBe(0);
    expect(data.minAdvanceBooking).toBe(0);
  });

  it("still applies the defaults when a field is absent", async () => {
    const data = await created({});
    expect(data).toMatchObject({
      isActive: true,
      isOnlineBookable: true,
      bufferTime: 15,
      minAdvanceBooking: 2,
      maxAdvanceBooking: 30,
      currency: "EUR",
    });
  });
});
