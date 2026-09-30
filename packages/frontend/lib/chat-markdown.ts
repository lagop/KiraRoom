/**
 * The little markdown the virtual receptionist writes, parsed into plain
 * data the chat widget renders as React elements (never as HTML, so nothing
 * in a reply can inject markup).
 *
 * The widget printed replies as one paragraph of raw text: "**Lunes a
 * viernes:**" with its asterisks, and a list of times run together on one
 * line, because the newlines were collapsed.
 *
 * Supported: **bold** and *bold* (the prompts use WhatsApp's single-asterisk
 * bold, since the same templates serve WhatsApp), "#" headings as bold
 * lines, "-", "*" or "•" bullet lists, "1." or "1)" numbered lists, line
 * breaks and blank-line paragraphs. Anything else is shown as written.
 */

export interface ChatInline {
  text: string;
  bold?: boolean;
}

export type ChatBlock =
  | { type: "paragraph"; lines: ChatInline[][] }
  | { type: "list"; ordered: boolean; start: number; items: ChatInline[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
// **bold** first, then *bold*. The single-asterisk form must hug its text,
// so "5 * 3" or a lone "*" stays as written.
const EMPHASIS = /\*\*(.+?)\*\*|\*(\S(?:.*?\S)?)\*/g;

export function parseInline(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  let last = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: m[1] ?? m[2], bold: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function parseChatMarkdown(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let paragraph: ChatInline[][] | null = null;
  let list: { ordered: boolean; start: number; items: ChatInline[][] } | null = null;

  const close = () => {
    if (paragraph) blocks.push({ type: "paragraph", lines: paragraph });
    if (list) blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
    paragraph = null;
    list = null;
  };

  for (const raw of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      close();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        close();
        // A numbered list keeps its own numbering: the model often puts a
        // description under "1." and goes on with "2.", which here starts
        // a new list -- that must still read 2, not 1 again.
        list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(parseInline(bullet ? bullet[1] : numbered![2]));
      continue;
    }

    if (list) close();
    const heading = HEADING.exec(line);
    const inline = heading ? [{ text: heading[1].replace(/\*/g, ""), bold: true }] : parseInline(line);
    if (!paragraph) paragraph = [];
    paragraph.push(inline);
  }
  close();
  return blocks;
}
