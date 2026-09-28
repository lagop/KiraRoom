import { ProfessionalsController } from "./professionals.controller";
import { ProfessionalsService } from "./professionals.service";

/**
 * Creating a professional takes the tenant from the caller's token.
 *
 * The dashboard's professionals screens sent 'default-tenant' (or a tenantId
 * read from localStorage, falling back to it), which the tenant scope
 * rejected with a 403. Same bug as POST /services; see services-create.spec.
 */

function setup() {
  const calls: any[] = [];
  const detected: string[] = [];
  const prisma = {
    professional: {
      create: async (args: any) => {
        calls.push(args);
        return { id: "pro-1", ...args.data };
      },
    },
  };
  const controller = new ProfessionalsController(
    new ProfessionalsService(prisma as any),
    { detect: async (t: string) => { detected.push(t); } } as any,
  );
  return { controller, calls, detected };
}

const OWNER = { id: "user-1", tenantId: "tenant-real", role: "owner" };

describe("POST /professionals", () => {
  it("creates the professional in the caller's tenant, whatever the body says", async () => {
    const { controller, calls, detected } = setup();

    await controller.create(OWNER, {
      tenantId: "default-tenant",
      firstName: "Ana",
      lastName: "García",
      email: "ana@salon.test",
    } as any);

    expect(calls[0].data.tenantId).toBe("tenant-real");
    expect(detected).toEqual(["tenant-real"]);
  });

  it("honours isActive: false", async () => {
    const { controller, calls } = setup();

    await controller.create(OWNER, {
      firstName: "Ana",
      lastName: "García",
      email: "ana@salon.test",
      isActive: false,
    } as any);

    expect(calls[0].data.isActive).toBe(false);
  });
});
