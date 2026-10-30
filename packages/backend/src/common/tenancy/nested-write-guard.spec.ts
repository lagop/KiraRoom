import { ForbiddenException } from "@nestjs/common";
import { assertSafeWrite } from "./tenant-scope.extension";

/**
 * A tenant request never writes the salon or its users through another
 * model's relation. `PATCH /appointments/:id` spread its body into the
 * update, so these bodies made a salon user the platform owner, reset the
 * owner's password, or moved the appointment to another salon.
 */
const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const refused = (model: string, operation: string, args: unknown) => {
  expect(() => assertSafeWrite(model, operation, args, TENANT)).toThrow(ForbiddenException);
};
const allowed = (model: string, operation: string, args: unknown) => {
  expect(() => assertSafeWrite(model, operation, args, TENANT)).not.toThrow();
};

describe("nested writes in a tenant request", () => {
  it("refuses promoting a user to platform owner through the appointment's salon", () => {
    refused("Appointment", "update", {
      where: { id: "a" },
      data: {
        tenant: { update: { users: { updateMany: { where: { email: "me@x" }, data: { role: "saas_owner" } } } } },
      },
    });
  });

  it("refuses changing the salon's plan or status through a child row", () => {
    refused("Appointment", "update", {
      where: { id: "a" },
      data: { tenant: { update: { subscriptionStatus: "active", trialEnd: "2099-01-01" } } },
    });
    refused("Product", "update", { where: { id: "p" }, data: { tenant: { update: { plan: "pro" } } } });
  });

  it("refuses resetting a user's password through a professional", () => {
    refused("Appointment", "update", {
      where: { id: "a" },
      data: { professional: { update: { user: { update: { passwordHash: "x", twoFactorEnabled: false } } } } },
    });
  });

  it("refuses moving a row to another salon, at the top or nested", () => {
    refused("Appointment", "update", { where: { id: "a" }, data: { tenantId: OTHER } });
    refused("Appointment", "update", { where: { id: "a" }, data: { tenant: { connect: { id: OTHER } } } });
    refused("Appointment", "update", {
      where: { id: "a" },
      data: { client: { update: { tenantId: OTHER } } },
    });
  });

  it("refuses an upsert or connectOrCreate that creates a user", () => {
    refused("Professional", "update", {
      where: { id: "p" },
      data: { user: { upsert: { create: { email: "x" }, update: { role: "owner" } } } },
    });
    refused("Professional", "create", {
      data: { tenantId: TENANT, user: { connectOrCreate: { where: { id: "u" }, create: { email: "x" } } } },
    });
  });

  it("allows the application's own writes", () => {
    allowed("Appointment", "update", { where: { id: "a" }, data: { notes: "hola", status: "confirmed" } });
    allowed("Appointment", "create", { data: { tenantId: TENANT, notes: "x" } });
    allowed("Professional", "create", {
      data: { tenant: { connect: { id: TENANT } }, user: { connect: { id: "u" } } },
    });
    allowed("Appointment", "update", {
      where: { id: "a" },
      data: { services: { create: [{ serviceId: "s", order: 0 }] } },
    });
    allowed("Appointment", "findMany", { where: { tenant: { update: {} } } });
  });
});
