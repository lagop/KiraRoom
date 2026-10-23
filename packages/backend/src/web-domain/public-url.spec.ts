import { salonPublicUrlFromEnv } from "./public-url";

/**
 * The address the receptionist and the QR codes give a client. They used to
 * build app.kiraroom.net/sites/<slug> by hand, so with subdomains live the
 * receptionist still sent clients to the old address.
 */
describe("salonPublicUrlFromEnv", () => {
  const LIVE = {
    APP_BASE_URL: "https://app.kiraroom.net",
    SALON_SUBDOMAIN_BASE: "kiraroom.net",
    SALON_SUBDOMAINS_READY: "1",
  } as NodeJS.ProcessEnv;
  const verified = { domain: "reservas.salonluna.es", verifiedAt: new Date("2026-10-01") };

  it("gives the subdomain once subdomains are live", () => {
    expect(salonPublicUrlFromEnv("salon-lucia", null, LIVE)).toBe("https://salon-lucia.kiraroom.net");
  });

  it("gives the salon's own domain when it is verified and served", () => {
    expect(salonPublicUrlFromEnv("salon-luna", verified, { ...LIVE, CUSTOM_DOMAINS_TLS_READY: "true" })).toBe(
      "https://reservas.salonluna.es",
    );
  });

  it("not the own domain while it is not served over HTTPS, or not verified", () => {
    expect(salonPublicUrlFromEnv("salon-luna", verified, LIVE)).toBe("https://salon-luna.kiraroom.net");
    expect(
      salonPublicUrlFromEnv("salon-luna", { ...verified, verifiedAt: null }, { ...LIVE, CUSTOM_DOMAINS_TLS_READY: "1" }),
    ).toBe("https://salon-luna.kiraroom.net");
  });

  it("falls back to /sites/<slug> when subdomains are off or the slug cannot have one", () => {
    expect(salonPublicUrlFromEnv("salon-lucia", null, { ...LIVE, SALON_SUBDOMAINS_READY: "" })).toBe(
      "https://app.kiraroom.net/sites/salon-lucia",
    );
    expect(salonPublicUrlFromEnv("admin", null, LIVE)).toBe("https://app.kiraroom.net/sites/admin");
  });

  it("uses FRONTEND_URL when there is no APP_BASE_URL", () => {
    expect(salonPublicUrlFromEnv("salon-lucia", null, { FRONTEND_URL: "https://app.kiraroom.net/" } as NodeJS.ProcessEnv)).toBe(
      "https://app.kiraroom.net/sites/salon-lucia",
    );
  });
});
