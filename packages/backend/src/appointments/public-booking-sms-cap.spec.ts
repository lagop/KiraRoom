import { phoneHash, publicBookingSmsHeld, publicSmsLimits, reservePublicBookingSms } from "./public-booking-sms-cap";

/**
 * R3 (hardening): a bot booking free slots could make KiraRoom send
 * unlimited confirmation SMS. Per rolling 24 h, a cap per salon and one per
 * number across salons; over it the SMS is held back, never the booking.
 */
function fakeDb(opts: { fail?: boolean } = {}) {
  const rows: any[] = [];
  const locks: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (_s: TemplateStringsArray, key: string) => {
      locks.push(key);
      return 0;
    }),
    publicBookingSms: {
      count: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.allowed === where.allowed &&
            r.createdAt > where.createdAt.gt &&
            (where.tenantId === undefined || r.tenantId === where.tenantId) &&
            (where.phoneHash === undefined || r.phoneHash === where.phoneHash),
        ).length,
      ),
      create: jest.fn(async ({ data }: any) => rows.push(data)),
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.appointmentId === where.appointmentId && r.allowed === where.allowed) ?? null,
      ),
    },
  };
  const db = {
    $transaction: jest.fn(async (fn: any) => {
      if (opts.fail) throw new Error("db down");
      return fn(tx);
    }),
    publicBookingSms: tx.publicBookingSms,
  };
  return { db, rows, locks };
}

const LIMITS = { perSalonPerDay: 3, perPhonePerDay: 2 };
const NOW = new Date("2026-11-04T10:00:00Z");
const book = (db: any, tenantId: string, phone: string, n: number, now = NOW) =>
  reservePublicBookingSms(db, { tenantId, appointmentId: `apt-${n}`, phone }, LIMITS, now);

describe("public booking SMS caps", () => {
  it("allows a number's first SMS and holds back the one over its cap, in any salon", async () => {
    const { db } = fakeDb();
    expect(await book(db, "salon-a", "600 111 222", 1)).toEqual({ allowed: true });
    // The same number written another way, at another salon.
    expect(await book(db, "salon-b", "+34600111222", 2)).toEqual({ allowed: true });
    expect(await book(db, "salon-c", "0034 600 111 222", 3)).toEqual({ allowed: false, reason: "phone" });
  });

  it("holds back a salon's SMS over its daily cap, whatever the number", async () => {
    const { db } = fakeDb();
    for (let i = 0; i < 3; i++) expect((await book(db, "salon-a", `60011100${i}`, i)).allowed).toBe(true);
    expect(await book(db, "salon-a", "600999888", 9)).toEqual({ allowed: false, reason: "salon" });
    // Another salon is not affected.
    expect((await book(db, "salon-b", "600999888", 10)).allowed).toBe(true);
  });

  it("counts a rolling day: yesterday's SMS no longer count", async () => {
    const { db } = fakeDb();
    const yesterday = new Date(NOW.getTime() - 25 * 3_600_000);
    await book(db, "salon-a", "600111222", 1, yesterday);
    await book(db, "salon-a", "600111222", 2, yesterday);
    expect((await book(db, "salon-a", "600111222", 3)).allowed).toBe(true);
  });

  it("records each decision without the number, under the salon's and the number's lock", async () => {
    const { db, rows, locks } = fakeDb();
    await book(db, "salon-a", "600 111 222", 1);
    expect(rows[0]).toMatchObject({ tenantId: "salon-a", appointmentId: "apt-1", allowed: true });
    expect(JSON.stringify(rows[0])).not.toContain("600111222");
    expect(JSON.stringify(rows[0])).not.toContain("111 222");
    expect(locks).toEqual(["public-sms:salon:salon-a", `public-sms:phone:${phoneHash("600111222")}`]);
  });

  it("fails closed: an error holds the SMS back", async () => {
    const { db } = fakeDb({ fail: true });
    expect(await book(db, "salon-a", "600111222", 1)).toEqual({ allowed: false, reason: "error" });
  });

  it("tells the reminders which bookings were held back", async () => {
    const { db } = fakeDb();
    await book(db, "salon-a", "600111222", 1);
    await book(db, "salon-a", "600111222", 2);
    await book(db, "salon-a", "600111222", 3);
    expect(await publicBookingSmsHeld(db as any, "apt-1")).toBe(false);
    expect(await publicBookingSmsHeld(db as any, "apt-3")).toBe(true);
    // Booked in the panel or imported: no record, not held.
    expect(await publicBookingSmsHeld(db as any, "apt-panel")).toBe(false);
  });

  it("reads its limits from the environment, with safe defaults", () => {
    expect(publicSmsLimits({})).toEqual({ perSalonPerDay: 40, perPhonePerDay: 3 });
    expect(
      publicSmsLimits({ PUBLIC_BOOKING_SMS_PER_SALON_DAY: "10", PUBLIC_BOOKING_SMS_PER_PHONE_DAY: "x" }),
    ).toEqual({ perSalonPerDay: 10, perPhonePerDay: 3 });
  });
});
