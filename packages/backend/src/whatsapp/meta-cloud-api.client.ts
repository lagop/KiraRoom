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

  /** Deletes a template (every language of it) from the salon's WhatsApp Business account. */
  async deleteTemplate(
    accessToken: string,
    wabaId: string,
    name: string,
  ): Promise<{ success?: boolean; error?: { code: number; message: string } }> {
    const url = `${this.baseUrl()}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`;
    const resp = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
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

  // --- Checking a manual connection, and the webhook subscription ---------

  /** The number as Meta knows it: its display number and verified name. */
  getPhoneNumber(
    accessToken: string,
    phoneNumberId: string,
  ): Promise<GraphCall<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>> {
    return this.graph(
      `${this.baseUrl()}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,quality_rating`,
      accessToken,
    );
  }

  /** The numbers of a WhatsApp Business account. */
  listPhoneNumbers(
    accessToken: string,
    wabaId: string,
  ): Promise<GraphCall<{ data: Array<{ id: string; display_phone_number?: string }> }>> {
    return this.graph(
      `${this.baseUrl()}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number&limit=100`,
      accessToken,
    );
  }

  /**
   * Whether the token is valid and when it expires (0 = never), read with
   * KiraRoom's app token. Only possible when the app is configured: null
   * otherwise, and the caller goes on without it.
   */
  async debugToken(
    accessToken: string,
  ): Promise<GraphCall<{ data: { is_valid?: boolean; expires_at?: number; app_id?: string } }> | null> {
    const appId = this.config.get<string>("META_APP_ID");
    const appSecret = this.config.get<string>("META_APP_SECRET");
    if (!appId || !appSecret) return null;
    const url = new URL(`${this.baseUrl()}/debug_token`);
    url.searchParams.set("input_token", accessToken);
    return this.graph(url.toString(), `${appId}|${appSecret}`);
  }

  /**
   * Subscribes the app the token belongs to to the account's webhooks
   * (messages, delivery statuses, quality and template updates). Without
   * it Meta delivers nothing to /webhooks/meta/whatsapp.
   */
  subscribeApp(accessToken: string, wabaId: string): Promise<GraphCall<{ success?: boolean }>> {
    return this.graph(`${this.baseUrl()}/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken, "POST");
  }

  /**
   * Unsubscribes the token's app from the account's webhooks: once a salon
   * disconnects, Meta stops sending its messages to KiraRoom.
   */
  unsubscribeApp(accessToken: string, wabaId: string): Promise<GraphCall<{ success?: boolean }>> {
    return this.graph(`${this.baseUrl()}/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken, "DELETE");
  }

  /** The apps subscribed to the account's webhooks. */
  listSubscribedApps(
    accessToken: string,
    wabaId: string,
  ): Promise<GraphCall<{ data: Array<{ whatsapp_business_api_data?: { id?: string; name?: string } }> }>> {
    return this.graph(`${this.baseUrl()}/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken);
  }

  /** One Graph call: `{ ok, data }` or `{ ok: false, error }`, never throws. The URL is never logged. */
  private async graph<T>(url: string, accessToken: string, method: "GET" | "POST" | "DELETE" = "GET"): Promise<GraphCall<T>> {
    try {
      const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` } });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.error) {
        return {
          ok: false,
          error: { code: Number(json?.error?.code ?? resp.status), message: json?.error?.message ?? `HTTP ${resp.status}` },
        };
      }
      return { ok: true, data: json as T };
    } catch (err) {
      return { ok: false, error: { code: -1, message: (err as Error).message, network: true } };
    }
  }
}

/** A Graph API answer: the body, or Meta's error. `network` when Meta could not be reached. */
export interface GraphCall<T> {
  ok: boolean;
  data?: T;
  error?: { code: number; message: string; network?: boolean };
}
