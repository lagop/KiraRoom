import { escapeHtml } from "../common/html-escape";
import { htmlToText } from "../common/html-to-text";

/**
 * What goes into a campaign email besides the salon's own HTML: the hidden
 * preheader, the plain-text part, and the promotion block of re-engagement
 * emails. Pure, so the rules are tested without a database
 * (campaign-content.spec.ts).
 */

/** The placeholders that only make sense with a promotion behind them. */
const PROMO_PLACEHOLDER = /\{\{\s*(?:discountCode|discountValue)\s*\}\}/;
const PROMO_PLACEHOLDER_ALL = /\{\{\s*(?:discountCode|discountValue)\s*\}\}/g;

/** The elements a promotion line usually sits in, innermost first. */
const PROMO_BLOCK_TAGS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "td", "tr", "div"];

export interface PromotionLike {
  isActive: boolean;
  endDate: Date | string | null;
  maxUses?: number | null;
  usedCount?: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a promotion's code can still be offered to a client: it exists,
 * is active, has not run out of uses, and its last day has not passed. The
 * end date is a calendar day ("Fecha fin"), stored as its UTC midnight, so
 * the code is still good for the whole of that day.
 */
export function promotionUsable(promotion: PromotionLike | null | undefined, now: Date = new Date()): boolean {
  if (!promotion || !promotion.isActive) return false;
  if (promotion.maxUses && (promotion.usedCount ?? 0) >= promotion.maxUses) return false;
  if (promotion.endDate) {
    const end = new Date(promotion.endDate).getTime();
    if (Number.isFinite(end) && now.getTime() >= end + DAY_MS) return false;
  }
  return true;
}

/** The Prisma filter for the same rule, for listing what can be linked. */
export function usablePromotionWhere(now: Date = new Date()) {
  return {
    isActive: true,
    OR: [{ endDate: null }, { endDate: { gt: new Date(now.getTime() - DAY_MS) } }],
  };
}

/**
 * The email without its promotion: the innermost paragraph, list item,
 * heading, cell or block that mentions {{discountCode}} or {{discountValue}}
 * is removed whole ("Usa el código {{discountCode}}" makes no sense without
 * a code), and any placeholder left outside such an element goes too. A
 * line of plain text that mentions one is removed. The client never sees a
 * literal "{{discountCode}}".
 */
export function withoutPromotion(html: string): string {
  let out = String(html ?? "");
  if (!PROMO_PLACEHOLDER.test(out)) return out;
  for (const tag of PROMO_BLOCK_TAGS) {
    // <tag ...> with no other <tag or </tag between it and the placeholder,
    // nor between the placeholder and its </tag>: the innermost one.
    const notTag = `(?:(?!<\\/?${tag}\\b)[\\s\\S])*?`;
    const block = new RegExp(`<${tag}\\b[^>]*>${notTag}${PROMO_PLACEHOLDER.source}${notTag}<\\/${tag}\\s*>`, "gi");
    let previous: string;
    do {
      previous = out;
      out = out.replace(block, "");
    } while (out !== previous && PROMO_PLACEHOLDER.test(out));
    if (!PROMO_PLACEHOLDER.test(out)) return out;
  }
  // Not inside any element: plain text. The line goes.
  out = out
    .split("\n")
    .filter((line) => !PROMO_PLACEHOLDER.test(line) || /<[^>]+>/.test(line))
    .join("\n");
  return out.replace(PROMO_PLACEHOLDER_ALL, "");
}

/** A subject without its promotion placeholders, and without the separator left dangling. */
export function subjectWithoutPromotion(subject: string): string {
  return String(subject ?? "")
    .replace(/\s*[-–—:|·,(]?\s*\{\{\s*(?:discountCode|discountValue)\s*\}\}\s*\)?/g, " ")
    .replace(/\s+([!?.,;:)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s\-–—:|·,(]+$/, "")
    .replace(/^[\s\-–—:|·,)]+/, "")
    .trim();
}

/**
 * The inbox preview line ("previewText"): a hidden block at the very top of
 * the body. Mail clients show the first text they find next to the
 * subject; without this they showed the first words of the email, or the
 * unsubscribe footer.
 */
export function withPreheader(html: string, previewText: string | null | undefined): string {
  const text = String(previewText ?? "").trim();
  if (!text) return html;
  const preheader =
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">` +
    `${escapeHtml(text)}</div>`;
  const body = /<body\b[^>]*>/i;
  return body.test(html) ? html.replace(body, (open) => `${open}${preheader}`) : `${preheader}${html}`;
}

/** The plain-text part sent next to the HTML. */
export function plainTextPart(html: string): string {
  return htmlToText(html);
}
