import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../common/prisma/prisma.service";
import { issueVisitorToken, legacyVisitorUuid, readVisitorToken, visitorKey } from "./visitor-token";

/**
 * Messages a day one person can send to a salon's receptionist from its
 * site. A booking takes about 7; the per-IP limit (20 a minute) stops bursts,
 * this stops one visitor from spending a salon's AI messages all day.
 */
export const VISITOR_DAILY_MESSAGES = 40;
export const CLIENT_DAILY_MESSAGES = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChatIdentity =
  /** A client signed in on this salon's site: their conversation is theirs. */
  | { kind: "client"; clientId: string }
  /** Anyone else: an id the server issued, signed, kept by the browser. */
  | { kind: "visitor"; clientId: string; visitorToken: string };

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

/**
 * Who is writing on the public chat, and whether they may write more today.
 * The endpoint stays public (visitors have no account), so a signed-in client
 * is recognised from their session here rather than by the auth guard.
 */
@Injectable()
export class PublicChatAccessService {
  private readonly jwt: JwtService;

  constructor(private readonly prisma: PrismaService) {
    // The app's JwtModule is registered in AppModule only; same secret.
    this.jwt = new JwtService({ secret: process.env.JWT_SECRET });
  }

  private secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error("JWT_SECRET is required to sign chat visitors");
    return s;
  }

  async identify(
    input: { salonId: string; visitorToken?: string; clientId?: string },
    authorization?: string,
  ): Promise<ChatIdentity> {
    const client = await this.signedInClient(input.salonId, authorization);
    if (client) return { kind: "client", clientId: client };

    const uuid =
      readVisitorToken(this.secret(), input.salonId, input.visitorToken) ??
      legacyVisitorUuid(input.clientId) ??
      undefined;
    const visitorToken = issueVisitorToken(this.secret(), input.salonId, uuid);
    const visitorUuid = readVisitorToken(this.secret(), input.salonId, visitorToken)!;
    return { kind: "visitor", clientId: visitorKey(visitorUuid), visitorToken };
  }

  /** The client id if the bearer token is a current session of a client of this salon. */
  private async signedInClient(salonId: string, authorization?: string): Promise<string | null> {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!m) return null;
    let payload: any;
    try {
      payload = this.jwt.verify(m[1]);
    } catch {
      return null;
    }
    if (payload?.role !== "client" || payload.tenantId !== salonId || typeof payload.sub !== "string") {
      return null;
    }
    const client = await this.prisma.client.findFirst({
      where: { id: payload.sub, tenantId: salonId },
      select: { id: true, tokenVersion: true },
    });
    // A token from before a logout or password change no longer counts.
    if (!client || (payload.tv ?? 0) !== client.tokenVersion) return null;
    return client.id;
  }

  async assertWithinDailyLimit(identity: ChatIdentity, tenantId: string, now = new Date()): Promise<void> {
    const limit = identity.kind === "client" ? CLIENT_DAILY_MESSAGES : VISITOR_DAILY_MESSAGES;
    const conversation =
      identity.kind === "client"
        ? { tenantId, clientId: identity.clientId }
        : { tenantId, context: { path: ["visitorKey"], equals: identity.clientId } };
    const sent = await this.prisma.chatMessage.count({
      where: {
        role: "user",
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        conversation,
      },
    });
    if (sent >= limit) throw new ChatDailyLimitException(limit);
  }
}
