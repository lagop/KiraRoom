/**
 * The public chat on a salon's site, browser side: the visitor token the
 * server issues, and what a visitor reads when a message is refused.
 * Pure, so it is tested without React (chat-visitor.spec.ts).
 */

/** Same limit as the API (PUBLIC_CHAT_MAX_MESSAGE). */
export const CHAT_MAX_MESSAGE = 1000;

/** One token per salon: the server signs it for that salon only. */
export function visitorTokenKey(salonId: string): string {
  return `kira_chat_token:${salonId}`;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readVisitorToken(storage: Storage | undefined, salonId: string): string | undefined {
  try {
    return storage?.getItem(visitorTokenKey(salonId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the token the answer brought (a new one replaces an unknown or old one). */
export function rememberVisitorToken(storage: Storage | undefined, salonId: string, token: unknown): void {
  if (typeof token !== "string" || !token) return;
  try {
    storage?.setItem(visitorTokenKey(salonId), token);
  } catch {
    // Storage blocked: the next message gets a fresh token, and a fresh chat.
  }
}

const GENERIC = "Ahora mismo no puedo responder. Inténtalo de nuevo en un momento.";

/**
 * What the visitor reads when a message fails. The daily limit and "too fast"
 * are explained; anything else gets the plain apology (the details go to the
 * console, not to them).
 */
export function chatErrorText(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const message = (error as { message?: string } | null)?.message;
  // Ajustes > Recepcionista "Chat en mi web" turned off after the page loaded.
  if (status === 403 && message && /chat de este salón/i.test(message)) return message;
  if (status === 429 && message && /máximo de mensajes/i.test(message)) return message;
  if (status === 429) return "Estás escribiendo muy rápido. Espera un momento y vuelve a intentarlo.";
  return GENERIC;
}

/**
 * The web chat forgets after this long without a message (the server's
 * WEB_CHAT_SESSION_MINUTES): the next one starts a new conversation.
 */
export const WEB_CHAT_IDLE_MINUTES = 30;

/** Whether the conversation on screen is over: nothing said for 30 minutes. */
export function chatSessionExpired(lastActivityAt: number | null, now: number = Date.now()): boolean {
  return lastActivityAt !== null && now - lastActivityAt > WEB_CHAT_IDLE_MINUTES * 60_000;
}
