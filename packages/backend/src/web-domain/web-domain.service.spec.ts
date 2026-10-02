import { BadRequestException } from "@nestjs/common";
import { WebDomainService } from "./web-domain.service";
import { DnsResolver, txtRecordName, txtRecordValue } from "./custom-domain";

/**
 * The custom-domain flow end to end, against an in-memory table and a fake
 * resolver.
 *
 * What it guards:
 *  - nothing is "purchased": the salon brings a domain, gets the two DNS
 *    records, and only real lookups mark it verified;
 *  - a verified domain is not reported as serving until the operator has
 *    HTTPS for customer domains (CUSTOM_DOMAINS_TLS_READY);
 *  - whoever proves ownership takes the domain from any other salon;
 *  - the daily re-check drops a domain only after two failures in a row.
 */

type Row = {
  id: string;
  tenantId: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
};

function makePrisma(rows: Row[]) {
  let seq = rows.length;
  const match = (r: Row, where: any) =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (v && typeof v === "object" && "not" in v) return (r as any)[k] !== v.not;
      return (r as any)[k] === v;
    });
  const customDomain = {
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => match(r, where))),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const existing = rows.find((r) => r.tenantId === where.tenantId);
      if (existing) return Object.assign(existing, update);
      const row = { id: `cd-${++seq}`, ...create };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const keep = rows.filter((r) => !match(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    }),
  };
  return {
    customDomain,
    tenant: { findUnique: jest.fn(async ({ where }: any) => ({ slug: `slug-${where.id}` })) },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

const TARGET = "app.kiraroom.net";

function makeService(rows: Row[], dnsRecords: Record<string, any>, env: Record<string, string> = {}) {
  const prisma = makePrisma(rows);
  const config = {
    get: (k: string) => ({ APP_BASE_URL: "https://app.kiraroom.net", ...env })[k],
  };
  const notFound = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  const dns: DnsResolver = {
    resolveTxt: (n) => (dnsRecords.txt?.[n] ? Promise.resolve(dnsRecords.txt[n]) : notFound()),
    resolveCname: (n) => (dnsRecords.cname?.[n] ? Promise.resolve(dnsRecords.cname[n]) : notFound()),
    resolve4: (n) => (dnsRecords.a?.[n] ? Promise.resolve(dnsRecords.a[n]) : notFound()),
  };
  return { svc: new WebDomainService(prisma as any, config as any, dns as any), prisma };
}

function pointed(domain: string, token: string) {
  return {
    txt: { [txtRecordName(domain)]: [[txtRecordValue(token)]] },
    cname: { [domain]: [TARGET] },
    a: { [TARGET]: ["203.0.113.7"] },
  };
}

describe("WebDomainService", () => {
  it("setDomain stores the domain unverified and returns the two records to create", async () => {
    const rows: Row[] = [];
    const { svc } = makeService(rows, { a: { [TARGET]: ["203.0.113.7"] } });
    const s = await svc.setDomain("t1", "https://Reservas.MiSalon.com/");

    expect(s.publicUrl).toBe("https://app.kiraroom.net/sites/slug-t1");
    expect(s.target).toBe(TARGET);
    expect(s.servingEnabled).toBe(false);
    expect(s.domain).toMatchObject({ name: "reservas.misalon.com", verified: false, active: false });
    const token = rows[0].verificationToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(s.domain!.records).toEqual([
      { type: "CNAME", name: "reservas.misalon.com", value: TARGET },
      { type: "TXT", name: "_kiraroom.reservas.misalon.com", value: `kiraroom-verify=${token}` },
    ]);
    expect(s.domain!.targetIps).toEqual(["203.0.113.7"]);
  });

  it("saving the same domain again keeps the token already published", async () => {
    const rows: Row[] = [];
    const { svc } = makeService(rows, {});
    await svc.setDomain("t1", "misalon.com");
    const token = rows[0].verificationToken;
    await svc.setDomain("t1", "MISALON.com");
    expect(rows[0].verificationToken).toBe(token);
    await svc.setDomain("t1", "otro.com");
    expect(rows[0].verificationToken).not.toBe(token);
  });

  it("refuses invalid and platform domains", async () => {
    const { svc } = makeService([], {});
    await expect(svc.setDomain("t1", "no es un dominio")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setDomain("t1", "app.kiraroom.net")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setDomain("t1", "otro.kiraroom.net")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("verify marks it verified only when DNS is right, and records why not", async () => {
    const rows: Row[] = [];
    const { svc } = makeService(rows, {});
    await svc.setDomain("t1", "misalon.com");
    const failed = await svc.verify("t1");
    expect(failed.domain).toMatchObject({ verified: false });
    expect(failed.domain!.lastCheckError).toContain("TXT");
    expect(rows[0].lastCheckedAt).toBeInstanceOf(Date);

    const ok = makeService(rows, pointed("misalon.com", rows[0].verificationToken));
    const s = await ok.svc.verify("t1");
    expect(s.domain).toMatchObject({ verified: true, lastCheckError: null, active: false });
  });

  it("a verified domain is active only once HTTPS for customer domains is enabled", async () => {
    const rows: Row[] = [
      { id: "cd-1", tenantId: "t1", domain: "misalon.com", verificationToken: "tok", verifiedAt: new Date(), lastCheckedAt: null, lastCheckError: null },
    ];
    const off = makeService(rows, {});
    expect((await off.svc.getStatus("t1")).domain!.active).toBe(false);
    const on = makeService(rows, {}, { CUSTOM_DOMAINS_TLS_READY: "1" });
    const s = await on.svc.getStatus("t1");
    expect(s.servingEnabled).toBe(true);
    expect(s.domain!.active).toBe(true);
  });

  it("proving ownership takes the domain from a salon that verified it before", async () => {
    const rows: Row[] = [
      { id: "cd-old", tenantId: "t-old", domain: "misalon.com", verificationToken: "old", verifiedAt: new Date("2026-01-01"), lastCheckedAt: null, lastCheckError: null },
      { id: "cd-new", tenantId: "t-new", domain: "misalon.com", verificationToken: "new", verifiedAt: null, lastCheckedAt: null, lastCheckError: null },
    ];
    const { svc } = makeService(rows, pointed("misalon.com", "new"));
    await svc.verify("t-new");
    expect(rows.find((r) => r.id === "cd-new")!.verifiedAt).toBeInstanceOf(Date);
    const old = rows.find((r) => r.id === "cd-old")!;
    expect(old.verifiedAt).toBeNull();
    expect(old.lastCheckError).toContain("Otro salón");
  });

  it("the daily re-check un-verifies only after two failures in a row", async () => {
    const rows: Row[] = [
      { id: "cd-1", tenantId: "t1", domain: "misalon.com", verificationToken: "tok", verifiedAt: new Date(), lastCheckedAt: null, lastCheckError: null },
    ];
    const broken = makeService(rows, {});
    await broken.svc.recheckVerified();
    expect(rows[0].verifiedAt).toBeInstanceOf(Date);
    expect(rows[0].lastCheckError).not.toBeNull();

    await broken.svc.recheckVerified();
    expect(rows[0].verifiedAt).toBeNull();
  });

  it("a passing re-check clears the previous failure", async () => {
    const rows: Row[] = [
      { id: "cd-1", tenantId: "t1", domain: "misalon.com", verificationToken: "tok", verifiedAt: new Date(), lastCheckedAt: null, lastCheckError: "timeout" },
    ];
    const { svc } = makeService(rows, pointed("misalon.com", "tok"));
    await svc.recheckVerified();
    expect(rows[0].verifiedAt).toBeInstanceOf(Date);
    expect(rows[0].lastCheckError).toBeNull();
  });

  it("removeDomain disconnects it", async () => {
    const rows: Row[] = [];
    const { svc } = makeService(rows, {});
    await svc.setDomain("t1", "misalon.com");
    const s = await svc.removeDomain("t1");
    expect(s.domain).toBeNull();
    expect(rows).toHaveLength(0);
  });
});
