import { NotFoundException } from "@nestjs/common";
import { clientAsStaffSees, clientReachWhere, maskedPhone } from "./client-reach";
import { ClientsService } from "./clients.service";
import { ConsentService } from "../consent/consent.service";

/**
 * Staff role, phase 2 (panel audit D16–D18): one reach rule for a
 * professional's clients, and what they see of a client's file.
 *
 * - D17: booking a client opens her file to the professional, but a
 *   cancelled appointment no longer does (book, cancel, keep the file).
 * - D18: in her file, a visit with another professional shows when, what
 *   and with whom: no price, payment or notes. The spend totals are the
 *   salon's money, so a professional gets none (null), not a partial sum.
 * - D16: the till masks a phone to its last three digits.
 */

describe("clientReachWhere (D17)", () => {
  it("an appointment with them that is not cancelled", () => {
    expect(clientReachWhere({ professionalId: "p1" })).toEqual({
      appointments: { some: { professionalId: "p1", status: { not: "cancelled" } } },
    });
    expect(clientReachWhere({ professional: { userId: "u1" } })).toEqual({
      appointments: { some: { professional: { userId: "u1" }, status: { not: "cancelled" } } },
    });
  });
});

describe("maskedPhone (D16)", () => {
  it.each([
    ["+34 600 111 222", "···· 222"],
    ["600-333-444", "···· 444"],
    ["12", "···· 12"],
  ])("%p → %p", (phone, masked) => {
    expect(maskedPhone(phone)).toBe(masked);
  });

  it.each([[null], [undefined], [""], ["sin teléfono"]])("%p: null", (phone) => {
    expect(maskedPhone(phone as any)).toBeNull();
  });
});

const visit = (id: string, professionalId: string) => ({
  id,
  scheduledDate: "2026-10-01",
  scheduledTime: "10:00",
  status: "completed",
  price: 30,
  totalAmount: 3000,
  amountPaid: 3000,
  paymentStatus: "paid",
  notes: `notes of ${id}`,
  service: { id: "s1", name: "Corte" },
  professional: { id: professionalId, firstName: "X", lastName: "Y" },
  services: [{ id: `${id}-1`, order: 0, service: { id: "s1", name: "Corte" }, professional: { id: professionalId } }],
});

describe("clientAsStaffSees (D18)", () => {
  const client = {
    id: "c1",
    firstName: "Ana",
    totalSpent: 120,
    averageSpent: 40,
    visitCount: 3,
    appointments: [visit("own", "p1"), visit("theirs", "p2")],
  };

  it("their own visits stay whole", () => {
    expect(clientAsStaffSees(client, "p1").appointments[0]).toEqual(visit("own", "p1"));
  });

  it("a colleague's visit: date, services and who, no price, payment or notes", () => {
    const seen = clientAsStaffSees(client, "p1").appointments[1] as any;
    expect(seen).toMatchObject({
      id: "theirs",
      scheduledDate: "2026-10-01",
      scheduledTime: "10:00",
      status: "completed",
      service: { name: "Corte" },
      professional: { id: "p2" },
      restricted: true,
      price: null,
      totalAmount: null,
      amountPaid: null,
      paymentStatus: null,
      notes: null,
    });
    expect(seen.services).toHaveLength(1);
  });

  it("no spend totals for staff (hidden, not a partial sum); the visit count stays", () => {
    const seen = clientAsStaffSees(client, "p1");
    expect(seen.totalSpent).toBeNull();
    expect(seen.averageSpent).toBeNull();
    expect(seen.visitCount).toBe(3);
  });

  it("a list row (no visits) only loses the totals", () => {
    const { appointments: _visits, ...row } = client;
    expect(clientAsStaffSees(row, "p1")).toEqual({ ...row, totalSpent: null, averageSpent: null });
  });
});

describe("ClientsService: the file as staff see it", () => {
  function service() {
    const findFirst = jest.fn(async () => ({
      id: "c1",
      tenantId: "t1",
      totalSpent: 120,
      appointments: [visit("own", "p1"), visit("theirs", "p2")],
    }));
    const findMany = jest.fn(async () => [{ id: "c1", totalSpent: 120 }]);
    return { svc: new ClientsService({ client: { findFirst, findMany } } as any), findFirst, findMany };
  }

  it("staff: reach without cancelled appointments, colleagues' visits restricted, no totals", async () => {
    const { svc, findFirst } = service();
    const file: any = await svc.findOne("t1", "c1", { professionalId: "p1" });
    expect((findFirst.mock.calls[0] as any[])[0].where).toEqual({
      id: "c1",
      tenantId: "t1",
      appointments: { some: { professionalId: "p1", status: { not: "cancelled" } } },
    });
    expect(file.totalSpent).toBeNull();
    expect(file.appointments[0].price).toBe(30);
    expect(file.appointments[1]).toMatchObject({ restricted: true, price: null, notes: null });
  });

  it("staff list rows carry no spend total", async () => {
    const { svc } = service();
    expect(await svc.findAll("t1", { professionalId: "p1" })).toEqual([{ id: "c1", totalSpent: null, averageSpent: null }]);
  });

  it("owner and admin: the file as it is", async () => {
    const { svc } = service();
    const file: any = await svc.findOne("t1", "c1", {});
    expect(file.totalSpent).toBe(120);
    expect(file.appointments[1].restricted).toBeUndefined();
    expect(file.appointments[1].notes).toBe("notes of theirs");
    expect(await svc.findAll("t1", {})).toEqual([{ id: "c1", totalSpent: 120 }]);
  });
});

describe("consents, notices and rebooking: the same reach (D17)", () => {
  /** Ana's only appointment with c1 was cancelled; with c2 it is confirmed. */
  const appointments = [
    { clientId: "c1", userId: "u-ana", status: "cancelled" },
    { clientId: "c2", userId: "u-ana", status: "confirmed" },
  ];
  function consent() {
    const findFirst = jest.fn(async ({ where }: any) => {
      const some = where.appointments?.some;
      if (!some) return { id: where.id };
      const live = appointments.some(
        (a) =>
          a.clientId === where.id &&
          a.userId === some.professional.userId &&
          a.status !== some.status?.not,
      );
      return live ? { id: where.id } : null;
    });
    return { svc: new ConsentService({ client: { findFirst } } as any, {} as any), findFirst };
  }

  it("a client whose only appointment with them was cancelled is out of reach: 404", async () => {
    const { svc } = consent();
    await expect(svc.assertClientInReach("t1", "c1", { id: "u-ana", role: "staff" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.assertClientInReach("t1", "c2", { id: "u-ana", role: "staff" })).resolves.toBeUndefined();
  });

  it("asks with the shared rule", async () => {
    const { svc, findFirst } = consent();
    await svc.assertClientInReach("t1", "c2", { id: "u-ana", role: "staff" });
    expect((findFirst.mock.calls[0] as any[])[0].where).toEqual({
      id: "c2",
      tenantId: "t1",
      ...clientReachWhere({ professional: { userId: "u-ana" } }),
    });
  });

  it("managers: any client of their salon", async () => {
    const { svc } = consent();
    await expect(svc.assertClientInReach("t1", "c1", { id: "u-boss", role: "owner" })).resolves.toBeUndefined();
  });
});
