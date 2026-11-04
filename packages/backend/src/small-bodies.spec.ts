import { AuthController } from "./auth/auth.controller";
import { ImpersonateDto, LogoutDto, RefreshTokenDto } from "./auth/dto/session-bodies.dto";
import { InvoicesController } from "./invoices/invoices.controller";
import { RectifyInvoiceDto, UploadCertificateDto } from "./invoices/dto/invoice.dto";
import { MessageBundlesController, TopUpCreditsDto } from "./message-bundles/message-bundles.controller";
import { PlatformLlmConfigController } from "./platform/platform-llm-config.controller";
import { AnthropicWorkspacesDto, UpdatePlatformLlmConfigDto } from "./platform/platform-llm-config.dto";
import { ManualWhatsAppConnectDto, WhatsAppController } from "./whatsapp/whatsapp.controller";
import { bodyMetatype, bodyParser } from "./common/validation/validated-body.testing";

/**
 * Bodies that were inline object types: sessions, invoices, WhatsApp,
 * message credits, the platform LLM setting. Each one is a validated class
 * now; these check the panel's payloads still pass and bad values do not.
 */
describe("small bodies", () => {
  it("are validated classes", () => {
    expect(bodyMetatype(AuthController, "impersonate")).toBe(ImpersonateDto);
    expect(bodyMetatype(AuthController, "refreshToken")).toBe(RefreshTokenDto);
    expect(bodyMetatype(AuthController, "logout")).toBe(LogoutDto);
    expect(bodyMetatype(InvoicesController, "rectify")).toBe(RectifyInvoiceDto);
    expect(bodyMetatype(InvoicesController, "uploadCertificate")).toBe(UploadCertificateDto);
    expect(bodyMetatype(MessageBundlesController, "topUp")).toBe(TopUpCreditsDto);
    expect(bodyMetatype(PlatformLlmConfigController, "update")).toBe(UpdatePlatformLlmConfigDto);
    expect(bodyMetatype(PlatformLlmConfigController, "listAnthropicWorkspaces")).toBe(AnthropicWorkspacesDto);
    expect(bodyMetatype(WhatsAppController, "manual")).toBe(ManualWhatsAppConnectDto);
  });

  it("session bodies: what the panel sends, or nothing", async () => {
    const refresh = bodyParser(AuthController, "refreshToken");
    expect(await refresh({})).toEqual({});
    expect(await refresh({ kind: "client", refreshToken: "abc" })).toEqual({ kind: "client", refreshToken: "abc" });
    await expect(refresh({ refreshToken: { $ne: "" } })).rejects.toBeDefined();
    const logout = bodyParser(AuthController, "logout");
    expect(await logout(undefined)).toEqual({});
    await expect(logout({ everywhere: "true" })).rejects.toBeDefined();
    const impersonate = bodyParser(AuthController, "impersonate");
    await expect(impersonate({ token: "t", reason: "x".repeat(501) })).rejects.toBeDefined();
  });

  it("a rectification has bounded lines; a credit line may be negative", async () => {
    const parse = bodyParser(InvoicesController, "rectify");
    const body = {
      reason: "Precio mal cobrado",
      lines: [{ description: "Corte", quantity: -1, unitPriceCents: 500, taxRate: 21 }],
    };
    expect(await parse(body)).toEqual(body);
    await expect(parse({ ...body, lines: [] })).rejects.toBeDefined();
    await expect(parse({ ...body, lines: [{ ...body.lines[0], taxRate: 210 }] })).rejects.toBeDefined();
    await expect(parse({ ...body, lines: [{ ...body.lines[0], unitPriceCents: 1.5 }] })).rejects.toBeDefined();
  });

  it("a certificate is base64 and a known provider", async () => {
    const parse = bodyParser(InvoicesController, "uploadCertificate");
    const body = { alias: "FNMT 2026", provider: "p12", pkcs12Base64: Buffer.from("cert").toString("base64"), passphrase: "x" };
    expect(await parse(body)).toEqual(body);
    await expect(parse({ ...body, provider: "pem" })).rejects.toBeDefined();
    await expect(parse({ ...body, pkcs12Base64: "not base64!" })).rejects.toBeDefined();
  });

  it("WhatsApp ids are Meta's numeric ids: they go into Graph API paths", async () => {
    const parse = bodyParser(WhatsAppController, "manual");
    const body = { accessToken: "EAAG", wabaId: "1029384756", phoneNumberId: "5647382910", displayPhone: "+34 600 000 000" };
    expect(await parse(body)).toEqual(body);
    await expect(parse({ ...body, phoneNumberId: "../me/accounts" })).rejects.toBeDefined();
    await expect(parse({ ...body, wabaId: "123?fields=access_token" })).rejects.toBeDefined();
  });

  it("credits are whole and positive", async () => {
    const parse = bodyParser(MessageBundlesController, "topUp");
    expect(await parse({ credits: "500" })).toEqual({ credits: 500 });
    await expect(parse({ credits: 0.5 })).rejects.toBeDefined();
  });

  it("the platform LLM form: strings or null, and no base URL (audit 8 P5)", async () => {
    const parse = bodyParser(PlatformLlmConfigController, "update");
    // What app/saas/settings/platform-llm/page.tsx saves.
    const body = { provider: "anthropic", defaultModel: "claude-haiku-4-5", workspaceId: null };
    expect({ ...(await parse(body)) }).toEqual(body);
    // A base URL is no longer a setting: it is dropped, never stored.
    expect((await parse({ baseUrl: "http://localhost:11434" })).baseUrl).toBeUndefined();
    await expect(parse({ apiKey: 12345 })).rejects.toBeDefined();
  });
});
