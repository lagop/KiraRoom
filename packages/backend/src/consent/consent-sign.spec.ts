import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { ROLES_KEY, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";

/**
 * Signing a consent form.
 *
 * `POST /consent/sign` was public and took the salon and the client from
 * the body, so a signature (with health answers) could be recorded for a
 * client without any session, and a signed consent is what lets her
 * appointment be confirmed. It now needs a session: the salon is the
 * session's and a team member records a signature taken in the salon
 * (clients have no accounts). Client, form, appointment and service must
 * all be the salon's.
 */

const FORM = { id: "form-1", tenantId: "t1", isActive: true, purpose: "custom", version: 2, fields: [{ id: "f_1" }] };

function makeService() {
  const created: any[] = [];
  const prisma: any = {
    consentForm: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === FORM.id ? FORM : null)),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === "t1" && ["ana", "bea"].includes(where.id)
          ? { id: where.id, firstName: where.id === "ana" ? "Ana" : "Bea", lastName: "López" }
          : null,
      ),
    },
    appointment: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === "apt-ana" && where.tenantId === "t1" && where.clientId === "ana"
          ? { serviceId: "svc-tinte", services: [{ serviceId: "svc-corte" }] }
          : null,
      ),
    },
    service: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === "t1" && ["svc-tinte", "svc-corte"].includes(where.id) ? { id: where.id } : null,
      ),
    },
    consent: {
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: "consent-1", ...data };
      }),
    },
  };
  const encryption: any = { hashIp: (ip: string) => `hash(${ip})` };
  return { service: new ConsentService(prisma, encryption), prisma, created };
}

const base = { tenantId: "t1", clientId: "ana", formId: FORM.id, responses: { f_1: true }, ip: "1.2.3.4" };

describe("POST /consent/sign: who may call it", () => {
  const handler = ConsentController.prototype.sign;

  it("is not public, and is open to the salon team only (clients have no accounts)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([...SALON_TEAM]);
  });

  function controller() {
    const sign = jest.fn(async (input: any) => input);
    return { ctl: new ConsentController({ sign } as any), sign };
  }
  const req = (user: any) => ({ user, headers: { "x-forwarded-for": "9.9.9.9" }, socket: {} }) as any;

  it("the team names the client and the name she signed with, and the record says who recorded it", async () => {
    const { ctl, sign } = controller();
    const staff = req({ id: "user-7", tenantId: "t1", role: "staff" });

    await expect(ctl.sign({ formId: FORM.id, signatureName: "Ana López" } as any, staff)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(ctl.sign({ formId: FORM.id, clientId: "ana" } as any, staff)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await ctl.sign({ formId: FORM.id, clientId: "ana", signatureName: "Ana López" } as any, staff);

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({ tenantId: "t1", clientId: "ana", recordedBy: "user-7" });
  });
});

describe("ConsentService.sign", () => {
  it("records a client's own signature with her name and the hashed IP", async () => {
    const { service, created } = makeService();

    await service.sign(base);

    expect(created[0]).toMatchObject({
      tenantId: "t1",
      clientId: "ana",
      formId: FORM.id,
      formVersion: 2,
      responses: { f_1: true },
      signatureName: "Ana López",
      signatureIpHash: "hash(1.2.3.4)",
    });
  });

  it("keeps who recorded a signature taken in the salon, and only the session can say it", async () => {
    const { service, created } = makeService();

    await service.sign({ ...base, signatureName: "Ana L.", recordedBy: "user-7" });
    await service.sign({ ...base, responses: { f_1: true, source: "salon", recordedBy: "user-9" } });

    expect(created[0].signatureName).toBe("Ana L.");
    expect(created[0].responses).toEqual({ f_1: true, source: "salon", recordedBy: "user-7" });
    expect(created[1].responses).toEqual({ f_1: true });
  });

  it("needs a typed name when the team records it", async () => {
    const { service } = makeService();
    await expect(service.sign({ ...base, recordedBy: "user-7" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a form, client, appointment or service of another salon", async () => {
    const { service, created } = makeService();

    await expect(service.sign({ ...base, tenantId: "t2" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.sign({ ...base, clientId: "someone-else" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.sign({ ...base, appointmentId: "apt-elsewhere" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.sign({ ...base, serviceId: "svc-elsewhere" })).rejects.toBeInstanceOf(NotFoundException);
    expect(created).toHaveLength(0);
  });

  it("refuses another client's appointment", async () => {
    const { service, prisma } = makeService();

    await expect(service.sign({ ...base, clientId: "bea", appointmentId: "apt-ana" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.appointment.findFirst.mock.calls[0][0].where).toEqual({ id: "apt-ana", tenantId: "t1", clientId: "bea" });
  });

  it("takes a service only if it is one of the appointment's", async () => {
    const { service, created } = makeService();

    await expect(
      service.sign({ ...base, appointmentId: "apt-ana", serviceId: "svc-other" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.sign({ ...base, appointmentId: "apt-ana", serviceId: "svc-tinte" });
    await service.sign({ ...base, appointmentId: "apt-ana", serviceId: "svc-corte" });

    expect(created.map((c) => [c.appointmentId, c.serviceId])).toEqual([
      ["apt-ana", "svc-tinte"],
      ["apt-ana", "svc-corte"],
    ]);
  });
});
