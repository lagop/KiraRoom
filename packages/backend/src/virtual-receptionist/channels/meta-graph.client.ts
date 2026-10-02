import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Graph API error body: `{ error: { message, type, code } }`. */
export interface GraphError {
  message: string;
  code?: number;
  type?: string;
}

export interface GraphResult<T> {
  ok: boolean;
  data?: T;
  error?: GraphError;
}

/** A Facebook Page the person manages, as /me/accounts returns it. */
export interface ManagedPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * Permissions the salon grants KiraRoom's Meta app when it connects its
 * Page: read the Pages it manages, receive and answer Messenger messages,
 * subscribe the Page to the app's webhooks, and the same for the Instagram
 * professional account linked to it.
 */
export const META_MESSAGING_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_manage_messages",
];

/**
 * The Graph API calls behind Messenger and Instagram Direct, in one place so
 * tests mock a single class instead of `fetch`.
 *
 * Endpoints, as documented by Meta:
 *  - Messenger send:   POST /{PAGE_ID}/messages?access_token=PAGE_TOKEN
 *  - Instagram send:   POST /me/messages?access_token=PAGE_TOKEN
 *  - Page webhooks:    POST /{PAGE_ID}/subscribed_apps?subscribed_fields=messages
 *  - Login:            facebook.com/{v}/dialog/oauth -> /oauth/access_token
 *  - Long-lived token: /oauth/access_token?grant_type=fb_exchange_token
 *  - Pages + tokens:   /me/accounts (Page tokens from a long-lived user token
 *                      do not expire)
 */
@Injectable()
export class MetaGraphClient {
  constructor(private readonly config: ConfigService) {}

  private version(): string {
    return this.config.get<string>("META_API_VERSION") || "v21.0";
  }

  private base(): string {
    return `https://graph.facebook.com/${this.version()}`;
  }

  /** KiraRoom's Meta app is configured (needed for Login and for webhook signatures). */
  isConfigured(): boolean {
    return !!this.config.get<string>("META_APP_ID") && !!this.config.get<string>("META_APP_SECRET");
  }

  buildLoginUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.get<string>("META_APP_ID") || "",
      redirect_uri: redirectUri,
      state,
      scope: META_MESSAGING_SCOPES.join(","),
      response_type: "code",
    });
    return `https://www.facebook.com/${this.version()}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GraphResult<{ access_token: string }>> {
    const url = new URL(`${this.base()}/oauth/access_token`);
    url.searchParams.set("client_id", this.config.get<string>("META_APP_ID") || "");
    url.searchParams.set("client_secret", this.config.get<string>("META_APP_SECRET") || "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code", code);
    return this.call(url.toString(), { method: "GET" });
  }

  async longLivedUserToken(shortLived: string): Promise<GraphResult<{ access_token: string }>> {
    const url = new URL(`${this.base()}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", this.config.get<string>("META_APP_ID") || "");
    url.searchParams.set("client_secret", this.config.get<string>("META_APP_SECRET") || "");
    url.searchParams.set("fb_exchange_token", shortLived);
    return this.call(url.toString(), { method: "GET" });
  }

  async listPages(userToken: string): Promise<GraphResult<{ data: ManagedPage[] }>> {
    const url = new URL(`${this.base()}/me/accounts`);
    url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
    url.searchParams.set("access_token", userToken);
    return this.call(url.toString(), { method: "GET" });
  }

  /** Delivers the Page's Messenger (and linked Instagram) messages to the app's webhook. */
  async subscribePage(pageId: string, pageToken: string): Promise<GraphResult<{ success: boolean }>> {
    const url = new URL(`${this.base()}/${encodeURIComponent(pageId)}/subscribed_apps`);
    url.searchParams.set("subscribed_fields", "messages");
    url.searchParams.set("access_token", pageToken);
    return this.call(url.toString(), { method: "POST" });
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<GraphResult<{ success: boolean }>> {
    const url = new URL(`${this.base()}/${encodeURIComponent(pageId)}/subscribed_apps`);
    url.searchParams.set("access_token", pageToken);
    return this.call(url.toString(), { method: "DELETE" });
  }

  /** A reply inside the 24-hour window the person's message opened. */
  async sendMessengerText(
    pageId: string,
    pageToken: string,
    psid: string,
    text: string,
  ): Promise<GraphResult<{ recipient_id: string; message_id: string }>> {
    const url = new URL(`${this.base()}/${encodeURIComponent(pageId)}/messages`);
    url.searchParams.set("access_token", pageToken);
    return this.call(url.toString(), {
      method: "POST",
      body: { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } },
    });
  }

  async sendInstagramText(
    pageToken: string,
    igsid: string,
    text: string,
  ): Promise<GraphResult<{ recipient_id: string; message_id: string }>> {
    const url = new URL(`${this.base()}/me/messages`);
    url.searchParams.set("access_token", pageToken);
    return this.call(url.toString(), {
      method: "POST",
      body: { recipient: { id: igsid }, message: { text } },
    });
  }

  private async call<T>(url: string, init: { method: string; body?: unknown }): Promise<GraphResult<T>> {
    try {
      const resp = await fetch(url, {
        method: init.method,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.error) {
        return {
          ok: false,
          error: {
            message: json?.error?.message ?? `HTTP ${resp.status}`,
            code: json?.error?.code,
            type: json?.error?.type,
          },
        };
      }
      return { ok: true, data: json as T };
    } catch (err) {
      return { ok: false, error: { message: (err as Error).message } };
    }
  }
}
