/**
 * NotificationsScheduler appointment reminders: catch-up selection, the
 * atomic claim, retries with a cap, the 1-hour email fallback and
 * placeholder addresses. Prisma is an in-memory table that applies the
 * where clauses the scheduler uses; providers are jest mocks.
 */
import { NotificationsScheduler, MAX_REMINDER_ATTEMPTS, REMINDER_24H } from "./notifications.scheduler";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = new Date("2026-11-02T09:00:00.000Z");

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(value);
      if (value === null || value === undefined) return false;
      return (
        (cond.gt === undefined || value > cond.gt) &&
        (cond.gte === undefined || value >= cond.gte) &&
        (cond.lt === undefined || value < cond.lt) &&
        (cond.lte === undefined || value <= cond.lte)
      );
    }
    return value === cond;
  });
}

function apply(row: any, data: any) {
  for (const [key, value] of Object.entries(data) as [string, any][]) {
    row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : value;
  }
}

function makePrisma(rows: any[]) {
  return {
    rows,
    appointment: {
      findMany: jest.fn(async (args: any) =>
        rows
          .filter((r) => matches(r, args.where))
          .sort((a, b) => a.startTime - b.startTime)
          .slice(0, args.take)
          .map((r) => ({ ...r })), // a snapshot, like a real read
      ),
      updateMany: jest.fn(async (args: any) => {
        const hit = rows.filter((r) => matches(r, args.where));
        hit.forEach((r) => apply(r, args.data));
        return { count: hit.length };
      }),
      update: jest.fn(async (args: any) => {
        const row = rows.find((r) => r.id === args.where.id);
        apply(row, args.data);
        return row;
      }),
    },
  };
}

let seq = 0;
function appointment(overrides: any = {}) {
  seq++;
  const startTime = overrides.startTime ?? new Date(NOW.getTime() + 23 * HOUR);
  return {
    id: `appt-${seq}`,
    tenantId: "t1",
    clientId: `client-${seq}`,
    createdAt: new Date(NOW.getTime() - 7 * 24 * HOUR),
    startTime,
    scheduledDate: new Date("2026-11-03T00:00:00.000Z"),
    scheduledTime: "10:00",
    status: "confirmed",
    reminder24hSent: false,
    reminder1hSent: false,
    reminder24hAttempts: 0,
    reminder1hAttempts: 0,
    client: { firstName: "Ana", lastName: "Gil", email: "ana@mail.test", phone: null },
    professional: { firstName: "Lu", lastName: "Paz" },
    service: { name: "Corte" },
    tenant: { name: "Salón", country: "ES" },
    ...overrides,
  };
}

function makeScheduler(prisma: any, opts: { sms?: boolean; prefs?: (channel: string) => boolean } = {}) {
  const email = {
    isConfigured: jest.fn(() => true),
    sendAppointmentReminder: jest.fn(async (..._args: unknown[]) => ({ success: true, id: "email-1" })),
  };
  const sms = {
    isConfigured: jest.fn(() => !!opts.sms),
    sendAppointmentReminder: jest.fn(async () => ({ success: true, id: "sms-1" })),
  };
  const whatsapp = {
    isConfigured: jest.fn(() => false),
    sendAppointmentReminder: jest.fn(async () => ({ success: false })),
  };
  const notifications = {
    create: jest.fn(async () => ({})),
    // Defaults: everything but WhatsApp, as DEFAULT_PREFERENCES.
    shouldSendNotification: jest.fn(async (_c: string, _t: string, channel: string) =>
      opts.prefs ? opts.prefs(channel) : channel !== "whatsapp",
    ),
  };
  const templates = {
    sendAppointmentReminder: jest.fn(async () => ({ sent: false, reason: "not_connected" })),
  };
  const scheduler = new NotificationsScheduler(
    prisma,
    email as any,
    sms as any,
    whatsapp as any,
    notifications as any,
    templates as any,
  );
  return { scheduler, email, sms, whatsapp, notifications, templates };
}


describe("24-hour reminders: catch-up selection", () => {
  it("takes every due, unsent appointment, not only those exactly 24 h away", async () => {
    const due23h = appointment({ startTime: new Date(NOW.getTime() + 23 * HOUR) });
    // Its 24 h mark passed 6 h ago, during a missed tick (deploy, restart).
    const missed = appointment({ startTime: new Date(NOW.getTime() + 18 * HOUR) });
    const notYet = appointment({ startTime: new Date(NOW.getTime() + 25 * HOUR) });
    const aboutToStart = appointment({ startTime: new Date(NOW.getTime() + 90 * MINUTE) });
    const alreadySent = appointment({ reminder24hSent: true });
    const cancelled = appointment({ status: "cancelled" });
    const started = appointment({ status: "in_progress" });
    const past = appointment({ startTime: new Date(NOW.getTime() - HOUR) });
    const noInstant = appointment({ startTime: null });
    // Booked this morning for this evening: after its 24 h mark.
    const bookedLate = appointment({
      createdAt: new Date(NOW.getTime() - 3 * HOUR),
      startTime: new Date(NOW.getTime() + 10 * HOUR),
    });
    const prisma = makePrisma([
      due23h, missed, notYet, aboutToStart, alreadySent, cancelled, started, past, noInstant, bookedLate,
    ]);
    const { scheduler, email } = makeScheduler(prisma);

    const counts = await scheduler.send24HourReminders(NOW);

    expect(counts.sent).toBe(2);
    const reminded = email.sendAppointmentReminder.mock.calls.map((c: any) => c[2].idempotencyKey);
    expect(reminded).toEqual([
      expect.stringContaining(missed.id),
      expect.stringContaining(due23h.id),
    ]);
    expect(email.sendAppointmentReminder.mock.calls[0][1]).toBe(24);
    expect(missed.reminder24hSent).toBe(true);
    expect(due23h.reminder24hSent).toBe(true);
    expect(notYet.reminder24hSent).toBe(false);
    expect(aboutToStart.reminder24hSent).toBe(false);
  });

  it("selects by the real UTC startTime", async () => {
    const prisma = makePrisma([]);
    const { scheduler } = makeScheduler(prisma);
    await scheduler.send24HourReminders(NOW);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.startTime).toEqual({
      gt: new Date(NOW.getTime() + 2 * HOUR),
      lte: new Date(NOW.getTime() + 24 * HOUR),
    });
    expect(where.status).toEqual({ in: ["pending", "confirmed"] });
    expect(where.reminder24hSent).toBe(false);
    expect(where.reminder24hAttempts).toEqual({ lt: MAX_REMINDER_ATTEMPTS });
  });
});

describe("reminder claim", () => {
  it("two instances on the same tick send each reminder once", async () => {
    const a = appointment();
    const b = appointment({ startTime: new Date(NOW.getTime() + 20 * HOUR) });
    const prisma = makePrisma([a, b]);
    const one = makeScheduler(prisma);
    const two = makeScheduler(prisma);

    await Promise.all([one.scheduler.send24HourReminders(NOW), two.scheduler.send24HourReminders(NOW)]);

    const sends = [...one.email.sendAppointmentReminder.mock.calls, ...two.email.sendAppointmentReminder.mock.calls];
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((c: any) => c[2].idempotencyKey)).size).toBe(2);
    expect(one.notifications.create.mock.calls.length + two.notifications.create.mock.calls.length).toBe(2);
    expect(a.reminder24hSent && b.reminder24hSent).toBe(true);
  });

  it("does not take a row whose attempt count changed since it was read", async () => {
    const a = appointment();
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma);
    const [snapshot] = await scheduler.dueReminders(REMINDER_24H, NOW);
    a.reminder24hAttempts = 1; // another instance failed a send meanwhile

    const outcome = await scheduler.remind(snapshot, REMINDER_24H);

    expect(outcome).toBeNull();
    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
  });
});

describe("reminder retries", () => {
  it("a failed send is released and retried on the next tick; marked sent only once delivered", async () => {
    const a = appointment();
    const prisma = makePrisma([a]);
    const { scheduler, email, notifications } = makeScheduler(prisma);
    email.sendAppointmentReminder.mockResolvedValueOnce({ success: false, error: "rate_limited" } as any);

    expect(await scheduler.send24HourReminders(NOW)).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(a.reminder24hSent).toBe(false);
    expect(a.reminder24hAttempts).toBe(1);

    expect(await scheduler.send24HourReminders(new Date(NOW.getTime() + HOUR))).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(a.reminder24hSent).toBe(true);
    expect(email.sendAppointmentReminder).toHaveBeenCalledTimes(2);
    // Same key on the retry: Resend drops a duplicate of a send that went through.
    expect(email.sendAppointmentReminder.mock.calls[0][2]).toEqual(email.sendAppointmentReminder.mock.calls[1][2]);
    // In-app notification once, not per attempt.
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("a thrown provider error counts as a failed attempt", async () => {
    const a = appointment();
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma);
    email.sendAppointmentReminder.mockRejectedValueOnce(new Error("socket hang up"));
    await scheduler.send24HourReminders(NOW);
    expect(a.reminder24hSent).toBe(false);
    expect(a.reminder24hAttempts).toBe(1);
  });

  it(`gives up after ${MAX_REMINDER_ATTEMPTS} attempts`, async () => {
    const a = appointment({ startTime: new Date(NOW.getTime() + 23 * HOUR) });
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma);
    email.sendAppointmentReminder.mockResolvedValue({ success: false, error: "down" } as any);

    for (let tick = 0; tick < 5; tick++) {
      await scheduler.send24HourReminders(new Date(NOW.getTime() + tick * HOUR));
    }

    expect(email.sendAppointmentReminder).toHaveBeenCalledTimes(MAX_REMINDER_ATTEMPTS);
    expect(a.reminder24hAttempts).toBe(MAX_REMINDER_ATTEMPTS);
    expect(a.reminder24hSent).toBe(false);
  });

  it("does not retry once the appointment is about to start", async () => {
    const a = appointment({ startTime: new Date(NOW.getTime() + 90 * MINUTE), reminder24hAttempts: 1 });
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma);
    await scheduler.send24HourReminders(NOW);
    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("one channel delivering is enough: no retry that would repeat it", async () => {
    const a = appointment({ client: { firstName: "Ana", lastName: "Gil", email: "ana@mail.test", phone: "600111222" } });
    const prisma = makePrisma([a]);
    const { scheduler, sms } = makeScheduler(prisma, { sms: true });
    sms.sendAppointmentReminder.mockResolvedValue({ success: false, error: "invalid number" } as any);
    await scheduler.send24HourReminders(NOW);
    expect(a.reminder24hSent).toBe(true);
    expect(a.reminder24hAttempts).toBe(0);
  });
});

describe("1-hour reminders", () => {
  const in1h = () => new Date(NOW.getTime() + 60 * MINUTE);

  it("go by email when the salon has neither SMS nor WhatsApp", async () => {
    const a = appointment({
      startTime: in1h(),
      client: { firstName: "Ana", lastName: "Gil", email: "ana@mail.test", phone: "600111222" },
    });
    const prisma = makePrisma([a]);
    const { scheduler, email, sms } = makeScheduler(prisma, { prefs: () => true });

    expect(await scheduler.send1HourReminders(NOW)).toEqual({ sent: 1, failed: 0, skipped: 0 });

    expect(sms.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(email.sendAppointmentReminder).toHaveBeenCalledTimes(1);
    expect(email.sendAppointmentReminder.mock.calls[0][0]).toMatchObject({ clientEmail: "ana@mail.test" });
    expect(email.sendAppointmentReminder.mock.calls[0][1]).toBe(1);
    expect(a.reminder1hSent).toBe(true);
  });

  it("go by email when the client has no phone", async () => {
    const a = appointment({ startTime: in1h() });
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma, { sms: true });
    await scheduler.send1HourReminders(NOW);
    expect(email.sendAppointmentReminder).toHaveBeenCalledTimes(1);
  });

  it("go by SMS, without email, when SMS is set up", async () => {
    const a = appointment({
      startTime: in1h(),
      client: { firstName: "Ana", lastName: "Gil", email: "ana@mail.test", phone: "600111222" },
    });
    const prisma = makePrisma([a]);
    const { scheduler, email, sms } = makeScheduler(prisma, { sms: true });
    await scheduler.send1HourReminders(NOW);
    expect(sms.sendAppointmentReminder).toHaveBeenCalledWith(expect.objectContaining({ clientPhone: "600111222" }), 1);
    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("a failed SMS is retried, not swapped for an email", async () => {
    const a = appointment({
      startTime: in1h(),
      client: { firstName: "Ana", lastName: "Gil", email: "ana@mail.test", phone: "600111222" },
    });
    const prisma = makePrisma([a]);
    const { scheduler, email, sms } = makeScheduler(prisma, { sms: true });
    sms.sendAppointmentReminder.mockResolvedValueOnce({ success: false, error: "twilio down" } as any);
    await scheduler.send1HourReminders(NOW);
    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(a.reminder1hSent).toBe(false);
    expect(a.reminder1hAttempts).toBe(1);
    await scheduler.send1HourReminders(new Date(NOW.getTime() + 15 * MINUTE));
    expect(sms.sendAppointmentReminder).toHaveBeenCalledTimes(2);
    expect(a.reminder1hSent).toBe(true);
  });

  it("the email fallback respects the client's email preference", async () => {
    const a = appointment({ startTime: in1h() });
    const prisma = makePrisma([a]);
    const { scheduler, email } = makeScheduler(prisma, { prefs: (channel) => channel !== "email" });
    expect(await scheduler.send1HourReminders(NOW)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("catch up within the hour, but not in the last 10 minutes", async () => {
    const missed = appointment({ startTime: new Date(NOW.getTime() + 30 * MINUTE) });
    const tooLate = appointment({ startTime: new Date(NOW.getTime() + 5 * MINUTE) });
    const prisma = makePrisma([missed, tooLate]);
    const { scheduler } = makeScheduler(prisma);
    await scheduler.send1HourReminders(NOW);
    expect(missed.reminder1hSent).toBe(true);
    expect(tooLate.reminder1hSent).toBe(false);
  });
});

describe("placeholder addresses", () => {
  it("never get a reminder email; with no other channel nothing is retried", async () => {
    const a = appointment({
      client: { firstName: "Ana", lastName: "", email: "wizard-1730000000000@placeholder.local", phone: null },
    });
    const b = appointment({
      startTime: new Date(NOW.getTime() + 50 * MINUTE),
      client: { firstName: "Eva", lastName: "", email: "wizard-1730000000001@placeholder.local", phone: null },
    });
    const prisma = makePrisma([a, b]);
    const { scheduler, email } = makeScheduler(prisma);

    expect(await scheduler.send24HourReminders(NOW)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await scheduler.send1HourReminders(NOW)).toEqual({ sent: 0, failed: 0, skipped: 1 });

    expect(email.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(a.reminder24hSent).toBe(true);
    expect(a.reminder24hAttempts).toBe(0);
    expect(b.reminder1hSent).toBe(true);
  });
});

describe("reminders name the service as it was booked", () => {
  it("says the name it was booked under, not the catalog's new one", async () => {
    const renamed = appointment({ serviceName: "Corte", service: { name: "Corte y peinado premium" } });
    const old = appointment({ startTime: new Date(NOW.getTime() + 20 * HOUR), service: { name: "Tinte" } });
    const { scheduler, email } = makeScheduler(makePrisma([renamed, old]));

    await scheduler.send24HourReminders(NOW);

    const names = email.sendAppointmentReminder.mock.calls.map((c: any) => c[0].serviceName).sort();
    // A row from before the snapshot (no serviceName) keeps the live name.
    expect(names).toEqual(["Corte", "Tinte"]);
  });
});
