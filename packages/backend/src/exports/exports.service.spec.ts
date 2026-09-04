import { ExportsService } from "./exports.service";

type Row = Record<string, any>;

function buildPrisma(rows: Row[]) {
  // Two-page cursor pagination: first page returns up to 1000 rows,
  // second page returns the tail (or empty).
  const txClients = rows.slice(0, 1000);
  const txTail = rows.slice(1000);

  const pagedQuery = jest.fn(async (args: any) => {
    const isTail = args.cursor !== undefined;
    return isTail ? txTail : txClients;
  });

  return {
    prisma: {
      client: { findMany: pagedQuery },
      appointment: { findMany: pagedQuery },
      payment: { findMany: pagedQuery },
      service: { findMany: pagedQuery },
      professional: { findMany: pagedQuery },
      walletTransaction: { findMany: pagedQuery },
      giftCard: { findMany: pagedQuery },
    },
  } as any;
}

function mockResponse(): any {
  const writable: any = {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    write(chunk: any) {
      this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    end() {
      this.ended = true;
    },
    ended: false,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return writable;
}

describe("ExportsService", () => {
  const tenantId = "tenant-1";

  describe("stream CSV", () => {
    it("emits header once, then data rows, with proper Content-Type", async () => {
      const rows = [
        { id: "1", firstName: "Ana", lastName: "P", email: "a@x.com", phone: "1", createdAt: "2026-01-01" },
        { id: "2", firstName: "Bea", lastName: "Q", email: "b@x.com", phone: "2", createdAt: "2026-01-02" },
      ];
      const { prisma } = buildPrisma(rows);
      const svc = new ExportsService(prisma);
      const res = mockResponse();

      await svc.stream(tenantId, "clients", "csv", res);

      const body = res.chunks.join("");
      expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["Content-Disposition"]).toContain("clients-");
      expect(res.headers["Content-Disposition"]).toContain(".csv");
      // Header is present once.
      const headerCount = (body.match(/id,firstName,lastName,email,phone,createdAt\n?/g) || []).length;
      expect(headerCount).toBe(1);
      // Data rows are present.
      expect(body).toContain("Ana,P");
      expect(body).toContain("Bea,Q");
      expect(res.ended).toBe(true);
    });

    it("does NOT duplicate header on subsequent pages", async () => {
      // Build 1500 rows so pagination kicks in.
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        id: String(i),
        firstName: `F${i}`,
        lastName: `L${i}`,
        email: `u${i}@x.com`,
        phone: String(i),
        createdAt: "2026-01-01",
      }));
      const { prisma } = buildPrisma(rows);
      const svc = new ExportsService(prisma);
      const res = mockResponse();

      await svc.stream(tenantId, "clients", "csv", res);

      const body = res.chunks.join("");
      const headerCount = (body.match(/id,firstName,lastName,email,phone,createdAt\n?/g) || []).length;
      expect(headerCount).toBe(1);
      // Spot-check rows from both pages.
      expect(body).toContain("F0,");
      expect(body).toContain("F1499,");
    });

    it("returns an empty body when no data", async () => {
      const { prisma } = buildPrisma([]);
      const svc = new ExportsService(prisma);
      const res = mockResponse();

      await svc.stream(tenantId, "clients", "csv", res);

      const body = res.chunks.join("");
      // No header, no rows — empty CSV.
      expect(body).toBe("");
      expect(res.ended).toBe(true);
    });

    it("scopes every entity query by tenantId", async () => {
      const { prisma } = buildPrisma([]);
      const svc = new ExportsService(prisma);
      const res = mockResponse();

      await svc.stream(tenantId, "appointments", "csv", res);

      const calls = (prisma.appointment.findMany as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [args] of calls) {
        expect(args.where.tenantId).toBe(tenantId);
      }
    });

    it("scopes wallet transactions via the nested wallet.tenantId relation", async () => {
      const { prisma } = buildPrisma([]);
      const svc = new ExportsService(prisma);
      const res = mockResponse();

      await svc.stream(tenantId, "wallet-transactions", "csv", res);

      const calls = (prisma.walletTransaction.findMany as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [args] of calls) {
        expect(args.where.wallet.tenantId).toBe(tenantId);
      }
    });
  });

  describe("stream XLSX", () => {
    it("sets xlsx content type and writes a workbook to the response", async () => {
      const rows = [
        { id: "1", firstName: "Ana", lastName: "P", email: "a@x.com", phone: "1", createdAt: "2026-01-01" },
      ];
      const { prisma } = buildPrisma(rows);
      const svc = new ExportsService(prisma);
      // ExcelJS WorkbookWriter requires a real Node.js writable stream.
      // We use a PassThrough + capture the bytes.
      const { PassThrough } = await import("stream");
      const pt = new PassThrough();
      const chunks: Buffer[] = [];
      pt.on("data", (c: Buffer) => chunks.push(c));
      const endedPromise = new Promise<void>((resolve) => pt.on("end", resolve));
      const fakeRes = Object.assign(pt, {
        setHeader(k: string, v: string) {
          (this as any).headers = { ...(this as any).headers, [k]: v };
        },
        headers: {} as Record<string, string>,
      });

      await svc.stream(tenantId, "clients", "xlsx", fakeRes as any);
      await endedPromise;

      expect(fakeRes.headers["Content-Type"]).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(fakeRes.headers["Content-Disposition"]).toContain(".xlsx");
      const body = Buffer.concat(chunks);
      expect(body.length).toBeGreaterThan(0);
      // XLSX files are ZIP archives; the first 2 bytes are "PK".
      expect(body[0]).toBe(0x50);
      expect(body[1]).toBe(0x4b);
    });
  });
});
