import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "../common/encryption/encryption.service";

export interface MetaCloudApiResponse<T = any> {
  messaging_product: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
  error?: { code: number; message: string; type?: string };
}

@Injectable()
export class MetaCloudApiClient {
  private readonly logger = new Logger(MetaCloudApiClient.name);

  constructor(
    private config: ConfigService,
    private encryption: EncryptionService,
  ) {}

  private baseUrl(): string {
    const version = this.config.get<string>("META_API_VERSION") || "v20.0";
    return `https://graph.facebook.com/${version}`;
  }

  buildOAuthUrl(state: string): string {
    const appId = this.config.get<string>("META_APP_ID");
    const redirect =
      this.config.get<string>("FRONTEND_URL")?.replace(/\/$/, "") ||
      "http://localhost:3000";
    const cb = `${redirect}/api/v1/whatsapp/connect/callback`;
    const params = new URLSearchParams({
      client_id: appId || "",
      redirect_uri: cb,
      state,
      scope: "whatsapp_business_management,whatsapp_business_messaging,business_management",
      response_type: "code",
    });
    return `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<{
    access_token: string;
    expires_in?: number;
    token_type?: string;
  }> {
    const appId = this.config.get<string>("META_APP_ID");
    const appSecret = this.config.get<string>("META_APP_SECRET");
    const url = new URL(`${this.baseUrl()}/oauth/access_token`);
    url.searchParams.set("client_id", appId || "");
    url.searchParams.set("client_secret", appSecret || "");
    url.searchParams.set("code", code);
    url.searchParams.set("redirect_uri", redirectUri);
    const resp = await fetch(url.toString(), { method: "GET" });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Meta token exchange failed (${resp.status}): ${body}`);
    }
    return resp.json() as any;
  }

  encryptToken(plain: string): string {
    return this.encryption.encrypt(plain);
  }

  decryptToken(cipher: string): string {
    return this.encryption.decrypt(cipher);
  }

  async sendTemplate(
    accessToken: string,
    phoneNumberId: string,
    to: string,
    templateName: string,
    languageCode: string,
    components: any[] = [],
  ): Promise<MetaCloudApiResponse> {
    const url = `${this.baseUrl()}/${phoneNumberId}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    });
    return (await resp.json()) as MetaCloudApiResponse;
  }

  /**
   * A free-text reply. Meta only allows it inside the 24-hour customer
   * service window opened by the person's last message, which is always the
   * case for the receptionist's answers.
   */
  async sendText(
    accessToken: string,
    phoneNumberId: string,
    to: string,
    body: string,
  ): Promise<MetaCloudApiResponse> {
    const resp = await fetch(`${this.baseUrl()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: body.slice(0, 4096) },
      }),
    });
    return (await resp.json()) as MetaCloudApiResponse;
  }

  /** Shows the two blue ticks on the person's message while the reply is prepared. */
  async markRead(accessToken: string, phoneNumberId: string, messageId: string): Promise<void> {
    await fetch(`${this.baseUrl()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  }

  /** Submits a message template for Meta's review on the salon's WhatsApp Business account. */
  async createTemplate(
    accessToken: string,
    wabaId: string,
    payload: Record<string, unknown>,
  ): Promise<{ id?: string; status?: string; error?: { code: number; message: string } }> {
    const resp = await fetch(`${this.baseUrl()}/${wabaId}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await resp.json()) as any;
  }

  async listTemplates(
    accessToken: string,
    wabaId: string,
  ): Promise<{ data: any[] }> {
    // Every WhatsApp campaign adds a template, so a salon soon has more than
    // the default page of 25: the standard ones must not fall off the list.
    const url = `${this.baseUrl()}/${wabaId}/message_templates?fields=name,status,language,components&limit=500`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (await resp.json()) as any;
  }

  /** One template by name, with Meta's review status and rejection reason. */
  async findTemplate(
    accessToken: string,
    wabaId: string,
    name: string,
  ): Promise<{ name: string; status: string; rejected_reason?: string; language?: string } | null> {
    const url =
      `${this.baseUrl()}/${wabaId}/message_templates?fields=name,status,rejected_reason,language&name=${encodeURIComponent(name)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await resp.json()) as any;
    if (body?.error) throw new Error(body.error.message ?? "Meta error");
    return (body?.data ?? []).find((t: any) => t?.name === name) ?? null;
  }
}
