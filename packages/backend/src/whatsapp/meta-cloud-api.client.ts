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

  async listTemplates(
    accessToken: string,
    wabaId: string,
  ): Promise<{ data: any[] }> {
    const url = `${this.baseUrl()}/${wabaId}/message_templates?fields=name,status,language,components`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (await resp.json()) as any;
  }
}