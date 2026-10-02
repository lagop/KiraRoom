import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConsentService } from "../consent/consent.service";
import { EmailSuppressionService } from "./email-suppression.service";

/**
 * Who an unsubscribe link belongs to: a campaign recipient row ("r"), or a
 * client for the re-engagement emails, whose recipient row is only written
 * after the send ("c"). Ids, never the address, so the link carries no
 * personal data.
 */
export type UnsubscribeTarget = { kind: "r" | "c"; id: string };

export interface UnsubscribeLink {
  /** The page the footer link opens: says which salon and asks to confirm. */
  pageUrl: string;
  /** RFC 8058 headers: mail clients show their own "unsubscribe" button. */
  headers: Record<string, string>;
}

const SIGNATURE_CHARS = 32;

/**
 * The unsubscribe link every marketing email carries (LSSI art. 21.2 and
 * 22.1: each commercial email must offer a simple, free way to object).
 *
 * The link is signed with a key derived from JWT_SECRET, so it needs no new
 * secret and cannot be forged to unsubscribe somebody else. Unsubscribing
 * puts the address on the salon's suppression list (every campaign and
 * re-engagement send skips it) and, for a known client, records the refusal
 * in the marketing consent, so the client's account shows the same answer.
 */
@Injectable()
export class EmailUnsubscribeService {
  private readonly logger = new Logger(EmailUnsubscribeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly suppressions: EmailSuppressionService,
    private readonly consent: ConsentService,
  ) {}

  tokenFor(target: UnsubscribeTarget): string {
    const payload = Buffer.from(`${target.kind}.${target.id}`).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** The target a token names, or null when it is malformed or not ours. */
  parse(token: string): UnsubscribeTarget | null {
    const [payload, signature, extra] = String(token ?? "").split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const decoded = Buffer.from(payload, "base64url").toString();
    const dot = decoded.indexOf(".");
    const kind = decoded.slice(0, dot);
    const id = decoded.slice(dot + 1);
    if ((kind !== "r" && kind !== "c") || !id) return null;
    return { kind, id };
  }

  link(target: UnsubscribeTarget): UnsubscribeLink {
    const token = this.tokenFor(target);
    const appBase = (
      this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL") ||
      "https://app.kiraroom.net"
    ).replace(/\/+$/, "");
    const pageUrl = `${appBase}/public/baja/${token}`;
    // One-click (RFC 8058) needs a URL that accepts a POST with no page in
    // between: the API's. Without API_BASE_URL the header points at the
    // page, which mail clients open like the footer link.
    const apiBase = this.config.get<string>("API_BASE_URL")?.trim().replace(/\/+$/, "");
    const headers: Record<string, string> = apiBase
      ? {
          "List-Unsubscribe": `<${apiBase}/api/v1/public/email/unsubscribe/${token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : { "List-Unsubscribe": `<${pageUrl}>` };
    return { pageUrl, headers };
  }

  /** The email's HTML with the unsubscribe footer, before </body> when there is one. */
  withFooter(html: string, salonName: string, pageUrl: string): string {
    const footer =
      `<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;` +
      `font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">` +
      `Recibes este email porque eres cliente de ${escapeHtml(salonName)}. ` +
      `Si no quieres recibir más promociones, ` +
      `<a href="${escapeHtml(pageUrl)}" style="color:#6b7280;text-decoration:underline">date de baja aquí</a>.` +
      `</p>`;
    const body = /<\/body>/i;
    return body.test(html) ? html.replace(body, `${footer}</body>`) : `${html}${footer}`;
  }

  /** What the page shows before the client confirms. */
  async describe(token: string): Promise<{ salonName: string; email: string; unsubscribed: boolean }> {
    const found = await this.resolve(token);
    const suppressed = await this.suppressions.suppressedAmong(found.tenantId, [found.email]);
    return {
      salonName: found.salonName,
      email: maskEmail(found.email),
      unsubscribed: suppressed.has(found.email.toLowerCase()),
    };
  }

  /** Unsubscribes the address from the salon's marketing emails. Idempotent. */
  async unsubscribe(token: string): Promise<{ salonName: string; unsubscribed: true }> {
    const found = await this.resolve(token);
    await this.suppressions.suppress(found.tenantId, found.email, "unsubscribed");

    if (found.clientId) {
      try {
        await this.consent.recordMarketingChoice({
          tenantId: found.tenantId,
          clientId: found.clientId,
          accepts: false,
        });
      } catch (err) {
        // The suppression list already stops the emails; the consent record
        // is what the client's account shows, so a failure is only logged.
        this.logger.warn(`marketing refusal for client ${found.clientId} not recorded: ${(err as Error).message}`);
      }
    }

    if (found.recipientId) {
      const marked = await this.prisma.emailCampaignRecipient.updateMany({
        where: { id: found.recipientId, unsubscribedAt: null },
        data: { unsubscribedAt: new Date() },
      });
      // Counted once per recipient, however many times the link is opened.
      if (marked.count > 0 && found.campaignId) {
        await this.prisma.emailCampaign.update({
          where: { id: found.campaignId },
          data: { unsubscribes: { increment: 1 } },
        });
      }
    }
    return { salonName: found.salonName, unsubscribed: true };
  }

  private async resolve(token: string) {
    const target = this.parse(token);
    if (!target) throw new NotFoundException("Enlace de baja no válido");

    if (target.kind === "r") {
      const recipient = await this.prisma.emailCampaignRecipient.findUnique({
        where: { id: target.id },
        select: {
          id: true,
          email: true,
          clientId: true,
          campaignId: true,
          campaign: { select: { tenantId: true, tenant: { select: { name: true } } } },
        },
      });
      if (!recipient) throw new NotFoundException("Enlace de baja no válido");
      return {
        tenantId: recipient.campaign.tenantId,
        salonName: recipient.campaign.tenant?.name ?? "el salón",
        email: recipient.email,
        clientId: recipient.clientId,
        recipientId: recipient.id,
        campaignId: recipient.campaignId,
      };
    }

    const client = await this.prisma.client.findUnique({
      where: { id: target.id },
      select: { id: true, email: true, tenantId: true, tenant: { select: { name: true } } },
    });
    if (!client?.email) throw new NotFoundException("Enlace de baja no válido");
    return {
      tenantId: client.tenantId,
      salonName: client.tenant?.name ?? "el salón",
      email: client.email,
      clientId: client.id,
      recipientId: null as string | null,
      campaignId: null as string | null,
    };
  }

  private sign(payload: string): string {
    const secret = this.config.get<string>("JWT_SECRET");
    if (!secret) throw new Error("JWT_SECRET is required to sign unsubscribe links");
    // A key of its own, derived, so a signature here is never a valid JWT
    // signature and vice versa.
    const key = createHmac("sha256", secret).update("email-unsubscribe:v1").digest();
    return createHmac("sha256", key).update(payload).digest("base64url").slice(0, SIGNATURE_CHARS);
  }
}

/** "ana.garcia@example.com" -> "an•••@example.com": enough to recognise it. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
