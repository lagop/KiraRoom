/**
 * Tests for the A3 (Wolters Kluwer) and NCS Spanish accounting adapters.
 *
 * The transports are stubbed in CI; these tests assert:
 *   - Auth flow returns OAuthTokens shape.
 *   - Idempotency: same externalRef → same externalId.
 *   - HTTP transport gated on FISCAL_E2E_MODE=real + endpoint env.
 */

import { ConfigService } from "@nestjs/config";
import { A3Adapter } from "./a3.adapter";
import { NCSAdapter } from "./ncs.adapter";

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (k: string) => env[k],
  } as unknown as ConfigService;
}

describe("A3Adapter (stub)", () => {
  it("initializes without throwing", () => {
    const a = new A3Adapter(
      makeConfig({ A3_WSDL_ENDPOINT: "https://test.example/wsdl" }),
    );
    expect(a.provider).toBe("a3");
  });

  it("getAuthUrl returns the manual-configure URL with state", () => {
    const a = new A3Adapter(
      makeConfig({ A3_WSDL_ENDPOINT: "https://test.example/wsdl" }),
    );
    const url = a.getAuthUrl("state-123");
    expect(url).toContain("state-123");
    expect(url).toContain("/dashboard/settings/accounting");
  });

  it("exchangeCode treats the code as a session token", async () => {
    const a = new A3Adapter(makeConfig({}));
    const tokens = await a.exchangeCode("user:password");
    expect(tokens.accessToken).toBe("user:password");
  });

  it("upsertSalesInvoice is idempotent on externalRef", async () => {
    const a = new A3Adapter(makeConfig({}));
    const r1 = await a.upsertSalesInvoice({
      externalRef: "t-1-A000001",
      issueDate: "2026-07-16",
      customerName: "Cliente",
      currency: "EUR",
      lines: [],
    });
    const r2 = await a.upsertSalesInvoice({
      externalRef: "t-1-A000001",
      issueDate: "2026-07-16",
      customerName: "Cliente",
      currency: "EUR",
      lines: [],
    });
    expect(r1.externalId).toBe(r2.externalId);
    expect(r1.externalId).toMatch(/^a3-stub-[0-9a-f]+$/);
  });

  it("throws in real mode without endpoint configured", async () => {
    const a = new A3Adapter(makeConfig({ FISCAL_E2E_MODE: "real" }));
    await expect(
      a.upsertSalesInvoice({
        externalRef: "t-1",
        issueDate: "2026-07-16",
        customerName: "C",
        currency: "EUR",
        lines: [],
      }),
    ).rejects.toThrow(/A3_WSDL_ENDPOINT not configured/);
  });

  it("ping returns true for non-empty token", async () => {
    const a = new A3Adapter(makeConfig({}));
    expect(await a.ping("token-value")).toBe(true);
    expect(await a.ping("")).toBe(false);
  });
});

describe("NCSAdapter (stub)", () => {
  it("initializes without throwing", () => {
    const n = new NCSAdapter(
      makeConfig({ NCS_WSDL_ENDPOINT: "https://test.example/wsdl" }),
    );
    expect(n.provider).toBe("ncs");
  });

  it("getAuthUrl returns the manual-configure URL with state", () => {
    const n = new NCSAdapter(makeConfig({}));
    const url = n.getAuthUrl("ncs-state");
    expect(url).toContain("ncs-state");
  });

  it("upsertSalesInvoice is idempotent on externalRef", async () => {
    const n = new NCSAdapter(makeConfig({}));
    const r1 = await n.upsertSalesInvoice({
      externalRef: "tenant-A000002",
      issueDate: "2026-07-16",
      customerName: "Cliente",
      currency: "EUR",
      lines: [],
    });
    const r2 = await n.upsertSalesInvoice({
      externalRef: "tenant-A000002",
      issueDate: "2026-07-16",
      customerName: "Cliente",
      currency: "EUR",
      lines: [],
    });
    expect(r1.externalId).toBe(r2.externalId);
    expect(r1.externalId).toMatch(/^ncs-stub-[0-9a-f]+$/);
  });

  it("throws in real mode without endpoint configured", async () => {
    const n = new NCSAdapter(makeConfig({ FISCAL_E2E_MODE: "real" }));
    await expect(
      n.upsertSalesInvoice({
        externalRef: "t-1",
        issueDate: "2026-07-16",
        customerName: "C",
        currency: "EUR",
        lines: [],
      }),
    ).rejects.toThrow(/NCS_WSDL_ENDPOINT not configured/);
  });
});
