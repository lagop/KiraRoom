import { AuthController } from "./auth/auth.controller";
import { ImpersonateDto, LogoutDto, RefreshTokenDto } from "./auth/dto/session-bodies.dto";
import { InvoicesController } from "./invoices/invoices.controller";
import { RectifyInvoiceDto, UploadCertificateDto } from "./invoices/dto/invoice.dto";
import { MessageBundlesController, TopUpCreditsDto } from "./message-bundles/message-bundles.controller";
import { PlatformLlmConfigController } from "./platform/platform-llm-config.controller";
import { AnthropicWorkspacesDto, UpdatePlatformLlmConfigDto } from "./platform/platform-llm-config.dto";
import { SmsController, TestSmsDto } from "./sms/sms.controller";
import { ManualWhatsAppConnectDto, WhatsAppController } from "./whatsapp/whatsapp.controller";
import { bodyMetatype, bodyParser } from "./common/validation/validated-body.testing";

/**
 * Bodies that were inline object types: sessions, invoices, SMS, WhatsApp,
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
    expect(bodyMetatype(SmsController, "test")).toBe(TestSmsDto);
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

  it("a test SMS goes to a phone number, three segments at most", async () => {
    const parse = bodyParser(SmsController, "test");
    expect(await parse({ to: "+34600000000", body: "Prueba" })).toEqual({ to: "+34600000000", body: "Prueba" });
    await expect(parse({ to: "premium-line", body: "x" })).rejects.toBeDefined();
    await expect(parse({ to: "+34600000000", body: "x".repeat(460) })).rejects.toBeDefined();
  });

  it("credits are whole and positive", async () => {
    const parse = bodyParser(MessageBundlesController, "topUp");
    expect(await parse({ credits: "500" })).toEqual({ credits: 500 });
    await expect(parse({ credits: 0.5 })).rejects.toBeDefined();
  });

  it("the platform LLM form: strings, a URL or null", async () => {
    const parse = bodyParser(PlatformLlmConfigController, "update");
    // What app/saas/settings/platform-llm/page.tsx saves.
    const body = { provider: "anthropic", defaultModel: "claude-haiku-4-5", baseUrl: null, workspaceId: null };
    expect(await parse(body)).toEqual(body);
    expect((await parse({ baseUrl: "http://localhost:11434" })).baseUrl).toBe("http://localhost:11434");
    await expect(parse({ apiKey: 12345 })).rejects.toBeDefined();
    await expect(parse({ baseUrl: "not a url" })).rejects.toBeDefined();
  });
});
