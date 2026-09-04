import { createHash } from "crypto";
import {
  buildVerifactuHuella,
  buildTicketBaiHuella,
} from "./fiscal.service";

describe("hash chain — Verifactu Huella", () => {
  const baseInput = {
    tenantNif: "B12345678",
    invoiceNumber: "A000001",
    issueDate: "2026-07-16",
    totalTaxCents: 2100,
    totalCents: 12100,
    previousHash: null as string | null,
  };

  it("first dispatch with no previousHash uses empty cadena", () => {
    const h = buildVerifactuHuella({ ...baseInput, previousHash: null });
    expect(h).toMatch(/^[0-9a-f]{64}$/);

    // Hash must be deterministic and not depend on randomness.
    const h2 = buildVerifactuHuella({ ...baseInput, previousHash: null });
    expect(h).toBe(h2);
  });

  it("changes when the previousHash is set (second dispatch in the chain)", () => {
    const first = buildVerifactuHuella({ ...baseInput, previousHash: null });
    const second = buildVerifactuHuella({ ...baseInput, previousHash: first });
    expect(second).not.toBe(first);

    // Chain reproducer: third dispatch must use second's hash.
    const third = buildVerifactuHuella({ ...baseInput, previousHash: second });
    expect(third).not.toBe(second);
  });

  it("changes when any single input changes", () => {
    const ref = buildVerifactuHuella({ ...baseInput, previousHash: null });
    expect(buildVerifactuHuella({ ...baseInput, previousHash: null, tenantNif: "X" }))
      .not.toBe(ref);
    expect(buildVerifactuHuella({ ...baseInput, previousHash: null, invoiceNumber: "A000002" }))
      .not.toBe(ref);
    expect(buildVerifactuHuella({ ...baseInput, previousHash: null, issueDate: "2026-07-17" }))
      .not.toBe(ref);
    expect(buildVerifactuHuella({ ...baseInput, previousHash: null, totalCents: 12101 }))
      .not.toBe(ref);
    expect(buildVerifactuHuella({ ...baseInput, previousHash: null, totalTaxCents: 2101 }))
      .not.toBe(ref);
  });

  it("matches an equivalent manual SHA-256 over the canonical input order", () => {
    // Helper test — if the algorithm ever changes, this catches drift.
    const orden = [
      baseInput.previousHash ?? "",
      baseInput.tenantNif,
      baseInput.invoiceNumber,
      baseInput.issueDate,
      baseInput.totalTaxCents.toFixed(2),
      baseInput.totalCents.toFixed(2),
    ].join("|");
    const expected = createHash("sha256").update(orden).digest("hex");
    expect(buildVerifactuHuella(baseInput)).toBe(expected);
  });
});

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

  it("Versifactu and TicketBAI hashes for the same inputs are NOT identical", () => {
    const ref = buildVerifactuHuella(baseInput);
    const tbai = buildTicketBaiHuella(baseInput);
    expect(tbai).not.toBe(ref);
  });
});
