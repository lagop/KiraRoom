import { clientEmailFilter, countryForPhone, normalizeClientEmail, normalizeClientPhone } from "./client-contact";

describe("how a client's email and phone are stored", () => {
  it("email: trimmed and lower-cased; blank is none; not sent is left alone", () => {
    expect(normalizeClientEmail("  Ana@Mail.ES ")).toBe("ana@mail.es");
    expect(normalizeClientEmail("   ")).toBeNull();
    expect(normalizeClientEmail(null)).toBeNull();
    expect(normalizeClientEmail(undefined)).toBeUndefined();
    expect(clientEmailFilter(" Ana@Mail.ES")).toEqual({ equals: "ana@mail.es", mode: "insensitive" });
  });

  it("phone: international form with the salon's country; a short number as typed", () => {
    expect(normalizeClientPhone("600 111 222")).toBe("+34600111222");
    expect(normalizeClientPhone("0034 600-111-222")).toBe("+34600111222");
    expect(normalizeClientPhone("+351 912 345 678", "PT")).toBe("+351912345678");
    expect(normalizeClientPhone("912 345 678", "PT")).toBe("+351912345678");
    expect(normalizeClientPhone(" 1234 ")).toBe("1234");
    expect(normalizeClientPhone("")).toBeNull();
    expect(normalizeClientPhone(undefined)).toBeUndefined();
  });

  it("asks for the salon's country only when a phone is written", async () => {
    const db: any = { tenant: { findUnique: jest.fn(async () => ({ country: "PT" })) }, $queryRaw: jest.fn() };
    expect(await countryForPhone(db, "t1", undefined)).toBe("ES");
    expect(await countryForPhone(db, "t1", "  ")).toBe("ES");
    expect(db.tenant.findUnique).not.toHaveBeenCalled();
    expect(await countryForPhone(db, "t1", "912345678")).toBe("PT");
  });
});
