import {
  DnsResolver,
  checkDomainDns,
  isPlatformDomain,
  normalizeDomain,
  txtRecordName,
  txtRecordValue,
} from "./custom-domain";

/**
 * A salon's own domain is served only when DNS proves two things: the salon
 * controls it (TXT with its token) and it points at the platform.
 *
 * The module this replaces "checked availability" by suffix and "bought" a
 * domain by flipping a flag; no lookup ever happened. These tests drive the
 * decisions with a fake resolver (no real DNS in tests).
 */

const TARGET = "app.kiraroom.net";
const TOKEN = "abc123";

function fakeDns(records: {
  txt?: Record<string, string[][]>;
  cname?: Record<string, string[]>;
  a?: Record<string, string[]>;
}): DnsResolver {
  const notFound = () => Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return {
    resolveTxt: async (n) => {
      if (records.txt?.[n]) return records.txt[n];
      throw notFound();
    },
    resolveCname: async (n) => {
      if (records.cname?.[n]) return records.cname[n];
      throw notFound();
    },
    resolve4: async (n) => {
      if (records.a?.[n]) return records.a[n];
      throw notFound();
    },
  };
}

const ownership = { [txtRecordName("reservas.misalon.com")]: [[txtRecordValue(TOKEN)]] };

describe("normalizeDomain", () => {
  it("reduces what people paste to the bare host", () => {
    expect(normalizeDomain("https://WWW.MiSalon.com/reservas?x=1")).toBe("www.misalon.com");
    expect(normalizeDomain("  reservas.misalon.com.  ")).toBe("reservas.misalon.com");
    expect(normalizeDomain("misalon.com:443")).toBe("misalon.com");
  });

  it("converts accented domains to the punycode DNS uses", () => {
    expect(normalizeDomain("peluquería.es")).toBe("xn--peluquera-n5a.es");
  });

  it("rejects things that are not a domain", () => {
    for (const bad of ["", "   ", "not a domain", "localhost", "192.168.1.10", "user:pw@misalon.com", "misalon", 42]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("isPlatformDomain", () => {
  it("refuses the platform's own names", () => {
    expect(isPlatformDomain("app.kiraroom.net", TARGET)).toBe(true);
    expect(isPlatformDomain("kiraroom.net", TARGET)).toBe(true);
    expect(isPlatformDomain("otro-salon.kiraroom.net", TARGET)).toBe(true);
    expect(isPlatformDomain("misalon.com", TARGET)).toBe(false);
  });
});

describe("checkDomainDns", () => {
  it("passes with the TXT token and a CNAME to the target", async () => {
    const dns = fakeDns({
      txt: ownership,
      cname: { "reservas.misalon.com": ["App.KiraRoom.net."] },
    });
    await expect(checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET)).resolves.toEqual({ ok: true });
  });

  it("passes for a root domain whose A records are the target's", async () => {
    const dns = fakeDns({
      txt: { [txtRecordName("misalon.com")]: [[txtRecordValue(TOKEN)]] },
      a: { "misalon.com": ["203.0.113.7"], [TARGET]: ["203.0.113.7"] },
    });
    await expect(checkDomainDns(dns, "misalon.com", TOKEN, TARGET)).resolves.toEqual({ ok: true });
  });

  it("joins a TXT value split in chunks", async () => {
    const dns = fakeDns({
      txt: { [txtRecordName("reservas.misalon.com")]: [["kiraroom-verify=", TOKEN]] },
      cname: { "reservas.misalon.com": [TARGET] },
    });
    await expect(checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET)).resolves.toEqual({ ok: true });
  });

  it("fails without the ownership record, even if the domain points here", async () => {
    // Pointing a domain at the platform says nothing about WHICH salon owns it.
    const dns = fakeDns({ cname: { "reservas.misalon.com": [TARGET] } });
    const r = await checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("_kiraroom.reservas.misalon.com");
  });

  it("fails with another salon's token", async () => {
    const dns = fakeDns({
      txt: { [txtRecordName("reservas.misalon.com")]: [[txtRecordValue("someone-else")]] },
      cname: { "reservas.misalon.com": [TARGET] },
    });
    const r = await checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no tiene el valor esperado") });
  });

  it("fails when the domain points elsewhere, and says where", async () => {
    const dns = fakeDns({
      txt: ownership,
      cname: { "reservas.misalon.com": ["old-host.example.net"] },
    });
    const r = await checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("old-host.example.net") });
  });

  it("fails when only some A records are ours (some visitors would miss)", async () => {
    const dns = fakeDns({
      txt: { [txtRecordName("misalon.com")]: [[txtRecordValue(TOKEN)]] },
      a: { "misalon.com": ["203.0.113.7", "198.51.100.1"], [TARGET]: ["203.0.113.7"] },
    });
    expect((await checkDomainDns(dns, "misalon.com", TOKEN, TARGET)).ok).toBe(false);
  });

  it("fails when nothing resolves", async () => {
    const dns = fakeDns({ txt: ownership });
    const r = await checkDomainDns(dns, "reservas.misalon.com", TOKEN, TARGET);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("todavía no apunta") });
  });
});
