import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { issueVisitorToken, legacyVisitorUuid, readVisitorToken, visitorKey } from "./visitor-token";

/**
 * Messages a day one person can send to a salon's receptionist from its
 * site. A booking takes about 7; the per-IP limit (20 a minute) stops bursts,
 * this stops one visitor from spending a salon's AI messages all day.
 */
export const VISITOR_DAILY_MESSAGES = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whoever writes: an id the server issued, signed, kept by the browser.
 * (Salon clients have no accounts, so nobody is recognised by a session.)
 */
export type ChatIdentity = { kind: "visitor"; clientId: string; visitorToken: string };

export class ChatDailyLimitException extends HttpException {
  constructor(limit: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: "chat_daily_limit",
        limit,
        message:
          "Has llegado al máximo de mensajes de hoy con la recepcionista. " +
          "Puedes reservar desde esta página o llamar al salón.",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Who is writing on the public chat, and whether they may write more today. */
@Injectable()
export class PublicChatAccessService {
  constructor(private readonly prisma: PrismaService) {}

  private secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error("JWT_SECRET is required to sign chat visitors");
    return s;
  }

  identify(input: { salonId: string; visitorToken?: string; clientId?: string }): ChatIdentity {
    const uuid =
      readVisitorToken(this.secret(), input.salonId, input.visitorToken) ??
      legacyVisitorUuid(input.clientId) ??
      undefined;
    const visitorToken = issueVisitorToken(this.secret(), input.salonId, uuid);
    const visitorUuid = readVisitorToken(this.secret(), input.salonId, visitorToken)!;
    return { kind: "visitor", clientId: visitorKey(visitorUuid), visitorToken };
  }

  async assertWithinDailyLimit(identity: ChatIdentity, tenantId: string, now = new Date()): Promise<void> {
    const sent = await this.prisma.chatMessage.count({
      where: {
        role: "user",
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        conversation: { tenantId, context: { path: ["visitorKey"], equals: identity.clientId } },
      },
    });
    if (sent >= VISITOR_DAILY_MESSAGES) throw new ChatDailyLimitException(VISITOR_DAILY_MESSAGES);
  }
}
