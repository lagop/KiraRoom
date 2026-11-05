import { buildTicketBaiHuella } from "./fiscal.service";

// The VERI*FACTU huella is tested against the AEAT worked examples in
// verifactu/verifactu-format.spec.ts.

describe("hash chain — TicketBAI Huella", () => {
  const baseInput = {
    tenantNif: "B12345678",
    invoiceNumber: "A000001",
    issueDate: "2026-07-16",
    totalTaxCents: 2100,
    totalCents: 12100,
    previousHash: null as string | null,
  };

  it("first dispatch produces a deterministic 64-hex hash", () => {
    const h = buildTicketBaiHuella({ ...baseInput, previousHash: null });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(buildTicketBaiHuella({ ...baseInput, previousHash: null }));
  });

  it("chains — second dispatch uses the first's hash", () => {
    const first = buildTicketBaiHuella({ ...baseInput, previousHash: null });
    const second = buildTicketBaiHuella({ ...baseInput, previousHash: first });
    const third = buildTicketBaiHuella({ ...baseInput, previousHash: second });
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(first).not.toBe(third);
  });
});
