import { Injectable } from "@nestjs/common";

export interface BotResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * The Telegram Bot API calls KiraRoom makes with each salon's bot token, in
 * one class so tests mock it instead of `fetch`. Every method answers
 * `{ ok, result | description }`, the Bot API's own response shape.
 *
 * The token is part of the URL (that is how the Bot API works), so these
 * URLs must never be logged.
 */
@Injectable()
export class TelegramBotClient {
  private url(token: string, method: string): string {
    return `https://api.telegram.org/bot${token}/${method}`;
  }

  getMe(token: string): Promise<BotResult<{ id: number; is_bot: boolean; username?: string; first_name: string }>> {
    return this.call(token, "getMe", {});
  }

  /**
   * Points the bot at KiraRoom. `secret_token` comes back in the
   * X-Telegram-Bot-Api-Secret-Token header of every update, which is how
   * the webhook knows the update is from Telegram and for this bot.
   */
  setWebhook(token: string, url: string, secretToken: string): Promise<BotResult<boolean>> {
    return this.call(token, "setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
  }

  deleteWebhook(token: string): Promise<BotResult<boolean>> {
    return this.call(token, "deleteWebhook", { drop_pending_updates: true });
  }

  sendMessage(token: string, chatId: string | number, text: string): Promise<BotResult<{ message_id: number }>> {
    return this.call(token, "sendMessage", { chat_id: chatId, text });
  }

  /** "escribiendo..." in the chat while the receptionist prepares the answer. */
  sendTyping(token: string, chatId: string | number): Promise<BotResult<boolean>> {
    return this.call(token, "sendChatAction", { chat_id: chatId, action: "typing" });
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<BotResult<T>> {
    try {
      const resp = await fetch(this.url(token, method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!json || typeof json.ok !== "boolean") {
        return { ok: false, description: `HTTP ${resp.status}`, error_code: resp.status };
      }
      return json as BotResult<T>;
    } catch (err) {
      return { ok: false, description: (err as Error).message };
    }
  }
}
