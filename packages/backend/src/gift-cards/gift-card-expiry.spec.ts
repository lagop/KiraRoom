import {
  defaultExpiryDay,
  endOfSalonDay,
  expiryDayOf,
  isPastDay,
  parseExpiryDay,
  safeTimeZone,
} from "./gift-card-expiry";
import { buildGiftCardEmail, displayCode } from "./gift-card-email";

describe("gift card expiry", () => {
  it("ends the picked day at 23:59:59.999 in the salon, across DST", () => {
    expect(endOfSalonDay("2026-12-31", "Europe/Madrid").toISOString()).toBe("2026-12-31T22:59:59.999Z");
    expect(endOfSalonDay("2026-07-31", "Europe/Madrid").toISOString()).toBe("2026-07-31T21:59:59.999Z");
    // The night the clocks go back (25 Oct 2026, Madrid).
    expect(endOfSalonDay("2026-10-25", "Europe/Madrid").toISOString()).toBe("2026-10-25T22:59:59.999Z");
    expect(endOfSalonDay("2026-12-31", "Atlantic/Canary").toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("reads the stored instant back as the same salon day", () => {
    const at = endOfSalonDay("2026-12-31", "Atlantic/Canary");
    expect(expiryDayOf(at, "Atlantic/Canary")).toBe("2026-12-31");
    expect(expiryDayOf(null, "Europe/Madrid")).toBeNull();
  });

  it("parses days and rejects impossible ones", () => {
    expect(parseExpiryDay("2026-12-31")).toBe("2026-12-31");
    expect(parseExpiryDay("2026-12-31T00:00:00.000Z")).toBe("2026-12-31");
    expect(parseExpiryDay("2026-02-30")).toBeNull();
    expect(parseExpiryDay("31/12/2026")).toBeNull();
  });

  it("defaults to two years from the salon's today", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Madrid.
    expect(defaultExpiryDay("Europe/Madrid", new Date("2026-12-31T23:30:00Z"))).toBe("2029-01-01");
    expect(defaultExpiryDay("Europe/Madrid", new Date("2028-02-29T12:00:00Z"))).toBe("2030-03-01");
  });

  it("compares against the salon's today", () => {
    const now = new Date("2026-11-01T23:30:00Z"); // 2 Nov in Madrid
    expect(isPastDay("2026-11-01", "Europe/Madrid", now)).toBe(true);
    expect(isPastDay("2026-11-02", "Europe/Madrid", now)).toBe(false);
  });

  it("falls back to Madrid on an unknown timezone", () => {
    expect(safeTimeZone("Mars/Olympus")).toBe("Europe/Madrid");
    expect(safeTimeZone(null)).toBe("Europe/Madrid");
    expect(safeTimeZone("Atlantic/Canary")).toBe("Atlantic/Canary");
  });
});

describe("gift card email", () => {
  it("escapes what comes from people, and handles no expiry", () => {
    const { html, text, subject } = buildGiftCardEmail({
      salonName: "Lola <b>",
      recipientName: "<script>",
      amountCents: 2550,
      code: "ABCDEF123456",
      expiresOn: null,
      message: "<img src=x>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("Lola &lt;b&gt;");
    expect(html).toContain("Sin fecha de caducidad");
    expect(text).toContain("ABCD EF12 3456");
    expect(subject).toContain("25,50");
  });

  it("groups the code in fours", () => {
    expect(displayCode("ABCDEF123456")).toBe("ABCD EF12 3456");
  });
});
