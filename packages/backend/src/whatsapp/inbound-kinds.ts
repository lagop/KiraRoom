/**
 * What the receptionist does with each kind of inbound message, per channel.
 *
 * Every message that was not text used to get "Por ahora solo puedo leer
 * mensajes de texto": a 👍 reaction to a reminder, Messenger's "like", a
 * sticker, an Instagram story mention, WhatsApp's system notices (the
 * client changed number) and the types the platform itself does not
 * support. Messenger's "Empezar" button got no answer at all.
 *
 *  - text     the receptionist answers it (button replies and "Empezar"
 *             included, as the text they carry / "Hola")
 *  - media    a voice note, photo, video, file, location or contact: the
 *             receptionist cannot read it, a short fixed reply says so
 *  - ignore   reactions, stickers, likes, story mentions, system and
 *             unsupported messages, anything unknown: no reply, no AI
 */
export type InboundKind = { kind: "text"; text: string } | { kind: "media" } | { kind: "ignore" };

const TEXT = (text: string): InboundKind => (text.trim() ? { kind: "text", text } : { kind: "ignore" });
const MEDIA: InboundKind = { kind: "media" };
const IGNORE: InboundKind = { kind: "ignore" };

const WHATSAPP_MEDIA = new Set(["audio", "voice", "image", "video", "document", "location", "contacts"]);

/** One message of a WhatsApp Cloud API webhook (`value.messages[]`). */
export function whatsAppInbound(m: any): InboundKind {
  switch (m?.type) {
    case "text":
      return typeof m.text?.body === "string" ? TEXT(m.text.body) : IGNORE;
    // A quick-reply button of a template (e.g. on a reminder).
    case "button":
      return typeof m.button?.text === "string" ? TEXT(m.button.text) : IGNORE;
    case "interactive": {
      const title = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
      return typeof title === "string" ? TEXT(title) : IGNORE;
    }
    default:
      // reaction, sticker, system, unsupported, ephemeral, order, unknown...
      return WHATSAPP_MEDIA.has(m?.type) ? MEDIA : IGNORE;
  }
}

/** Messenger's "Get Started" / "Empezar" button, whatever payload the Page set. */
const GET_STARTED = /get[\s_-]?started|empezar|comenzar/i;

/**
 * One `entry[].messaging[]` event of a Messenger or Instagram webhook.
 * Echoes and deleted messages are filtered by the caller.
 */
export function metaInbound(event: any): InboundKind {
  const postback = event?.postback;
  if (postback && !event?.message) {
    const label = `${postback.payload ?? ""} ${postback.title ?? ""}`;
    if (GET_STARTED.test(label)) return TEXT("Hola");
    // A persistent-menu or ice-breaker button: what it says.
    return typeof postback.title === "string" ? TEXT(postback.title) : IGNORE;
  }
  const message = event?.message;
  if (!message || message.is_unsupported) return IGNORE;
  // The "like" button and stickers carry a sticker_id and no text.
  if (message.sticker_id) return IGNORE;
  if (typeof message.text === "string" && message.text.trim()) return TEXT(message.text);
  const attachments: any[] = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length === 0) return IGNORE;
  const real = attachments.filter(
    (a) => a?.type !== "story_mention" && !a?.payload?.sticker_id && a?.type !== "sticker",
  );
  return real.length > 0 ? MEDIA : IGNORE;
}

const TELEGRAM_MEDIA = ["photo", "voice", "audio", "video", "video_note", "document", "location", "venue", "contact"];

/** A Telegram `message` (private chat). */
export function telegramInbound(message: any): InboundKind {
  if (typeof message?.text === "string") return TEXT(message.text);
  if (TELEGRAM_MEDIA.some((k) => message?.[k] !== undefined)) return MEDIA;
  // sticker, animation, dice, poll, service messages...
  return IGNORE;
}

/**
 * The fixed reply to a voice note or a photo. On Messenger and Instagram
 * the salon sees the conversation in Meta Business Suite; on WhatsApp (a
 * Cloud API number has no app) and Telegram (a bot's chats are not shown to
 * its owner) nobody else does, so the reply does not promise it.
 */
export function mediaReply(channel: "whatsapp" | "facebook" | "instagram" | "telegram", salonPhone?: string | null): string {
  const call = salonPhone ? `, o llama al salón al ${salonPhone}` : "";
  return channel === "facebook" || channel === "instagram"
    ? `No puedo escuchar audios ni ver fotos o archivos, pero el salón lo verá. Si quieres, escríbeme lo que necesitas y te ayudo${call}.`
    : `No puedo escuchar audios ni ver fotos o archivos. Escríbeme lo que necesitas y te ayudo${call}.`;
}
