/**
 * Turning the receptionist's answer into something each chat app shows well.
 *
 * The receptionist writes Markdown for the web chat. Messenger, Instagram
 * and Telegram (without parse_mode) show it literally: "**Martes**" arrives
 * with the asterisks, a "### Horario" heading with the hashes. Plain text
 * reads better on all three, so the marks are dropped and links become
 * "text: url" (every one of these apps makes bare URLs clickable).
 */
export function toPlainChatText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Per-message length limits. Instagram refuses text of 1000 characters or
 * more; Messenger's limit is 2000; Telegram's sendMessage takes 1-4096.
 */
export const CHANNEL_TEXT_LIMIT = {
  facebook: 2000,
  instagram: 999,
  telegram: 4096,
} as const;

/**
 * Splits a long answer into messages under the channel's limit, at a
 * paragraph or line break when there is one, so a list of services is not
 * cut in the middle of a line.
 */
export function splitForChannel(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
