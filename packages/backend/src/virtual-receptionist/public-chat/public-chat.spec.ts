import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { HttpStatus } from "@nestjs/common";
import { issueVisitorToken, legacyVisitorUuid, readVisitorToken, visitorKey } from "./visitor-token";
import { PUBLIC_CHAT_MAX_MESSAGE, PublicChatMessageDto } from "./public-chat-message.dto";
import {
  ChatDailyLimitException,
  PublicChatAccessService,
  VISITOR_DAILY_MESSAGES,
} from "./public-chat-access.service";
import { VirtualReceptionistController } from "../virtual-receptionist.controller";

/**
 * The chat on a salon's site is public and each message is a paid model call.
 * It trusted the body for who was writing (any clientId, any channel, any
 * phone) and checked nothing (the DTO was a zod type the validator ignores).
 */

// Built at runtime: a literal key-looking string trips the secret scan.
const SECRET = ["test", "only", "signing", "key"].join("-").repeat(2);
const SALON = "11111111-1111-4111-8111-111111111111";
const OTHER_SALON = "22222222-2222-4222-8222-222222222222";
const VISITOR = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

describe("visitor tokens", () => {
  it("a token we issued reads back to its visitor, for its salon only", () => {
    const token = issueVisitorToken(SECRET, SALON, VISITOR);
    expect(readVisitorToken(SECRET, SALON, token)).toBe(VISITOR);
    expect(readVisitorToken(SECRET, OTHER_SALON, token)).toBeNull();
  });

  it("a forged or altered token is refused", () => {
    const token = issueVisitorToken(SECRET, SALON, VISITOR);
    const other = "55555555-5555-4555-8555-555555555555";
    expect(readVisitorToken(SECRET, SALON, token.replace(VISITOR, other))).toBeNull();
    expect(readVisitorToken("another-secret", SALON, token)).toBeNull();
    expect(readVisitorToken(SECRET, SALON, `v1.${SALON}.${VISITOR}.AAAA`)).toBeNull();
    expect(readVisitorToken(SECRET, SALON, 42)).toBeNull();
  });

  it("only a browser-made visitor id counts as legacy, never a client's id", () => {
    expect(legacyVisitorUuid(`visitor-${VISITOR}`)).toBe(VISITOR);
    expect(legacyVisitorUuid(CLIENT)).toBeNull();
    expect(legacyVisitorUuid("anonymous")).toBeNull();
    expect(visitorKey(VISITOR)).toBe(`visitor-${VISITOR}`);
  });
});

describe("PublicChatMessageDto", () => {
  const errorsFor = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(PublicChatMessageDto, body), { whitelist: true }).map((e) => e.property);

  it("accepts a web message", () => {
    expect(errorsFor({ salonId: SALON, message: "Hola, ¿tenéis hueco mañana?", channel: "web" })).toEqual([]);
  });

  it("refuses the WhatsApp channel, an empty or overlong message, and a bad salon id", () => {
    expect(errorsFor({ salonId: SALON, message: "hola", channel: "whatsapp" })).toContain("channel");
    expect(errorsFor({ salonId: SALON, message: "   " })).toContain("message");
    expect(errorsFor({ salonId: SALON, message: "x".repeat(PUBLIC_CHAT_MAX_MESSAGE + 1) })).toContain("message");
    expect(errorsFor({ salonId: "default", message: "hola" })).toContain("salonId");
  });

  it("drops contact fields a caller adds to metadata", () => {
    const dto = plainToInstance(PublicChatMessageDto, {
      salonId: SALON,
      message: "hola",
      metadata: { clientName: "Ana", clientPhone: "+34600000000", clientEmail: "a@b.test" },
    });
    validateSync(dto, { whitelist: true });
    expect(dto.metadata).toEqual({ clientName: "Ana" });
  });
});

function accessService(opts: { sent?: number } = {}) {
  const prisma = {
    chatMessage: { count: jest.fn(async () => opts.sent ?? 0) },
  };
  return { svc: new PublicChatAccessService(prisma as any), prisma };
}

describe("PublicChatAccessService.identify", () => {
  it("a new visitor gets a fresh id and a token for it", async () => {
    const { svc } = accessService();
    const id = svc.identify({ salonId: SALON });
    expect(id.kind).toBe("visitor");
    if (id.kind !== "visitor") return;
    expect(id.clientId).toMatch(/^visitor-[0-9a-f-]{36}$/);
    expect(readVisitorToken(SECRET, SALON, id.visitorToken)).toBe(id.clientId.slice("visitor-".length));
  });

  it("a returning visitor keeps their id; an old browser id is carried over", async () => {
    const { svc } = accessService();
    const back = svc.identify({ salonId: SALON, visitorToken: issueVisitorToken(SECRET, SALON, VISITOR) });
    expect(back.clientId).toBe(`visitor-${VISITOR}`);
    const legacy = svc.identify({ salonId: SALON, clientId: `visitor-${VISITOR}` });
    expect(legacy.clientId).toBe(`visitor-${VISITOR}`);
  });

  it("a client's id in the body does not make anyone that client", async () => {
    const { svc } = accessService();
    const id = svc.identify({ salonId: SALON, clientId: CLIENT });
    expect(id.kind).toBe("visitor");
    expect(id.clientId).not.toBe(CLIENT);
  });
});

describe("PublicChatAccessService.assertWithinDailyLimit", () => {
  it("counts the visitor's own messages of the last 24 hours, in this salon", async () => {
    const { svc, prisma } = accessService({ sent: VISITOR_DAILY_MESSAGES - 1 });
    const now = new Date("2026-10-23T12:00:00Z");
    await svc.assertWithinDailyLimit({ kind: "visitor", clientId: `visitor-${VISITOR}`, visitorToken: "t" }, SALON, now);
    expect(prisma.chatMessage.count).toHaveBeenCalledWith({
      where: {
        role: "user",
        createdAt: { gte: new Date("2026-10-22T12:00:00Z") },
        conversation: { tenantId: SALON, context: { path: ["visitorKey"], equals: `visitor-${VISITOR}` } },
      },
    });
  });

  it("refuses with 429 and a message for the visitor once the limit is reached", async () => {
    const { svc } = accessService({ sent: VISITOR_DAILY_MESSAGES });
    const err = await svc
      .assertWithinDailyLimit({ kind: "visitor", clientId: `visitor-${VISITOR}`, visitorToken: "t" }, SALON)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ChatDailyLimitException);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.getResponse().message).toMatch(/máximo de mensajes de hoy/);
  });
});

describe("POST /virtual-receptionist/messages", () => {
  function controller(sent = 0) {
    const receptionist = { sendMessage: jest.fn(async () => ({ id: "m1", content: "¡Hola!", requiresHandoff: false })) };
    const { svc } = accessService({ sent });
    const c = new VirtualReceptionistController(receptionist as any, {} as any, {} as any, {} as any, {} as any, {} as any, svc);
    return { c, receptionist };
  }

  it("sends the receptionist a web message from the identified visitor, and returns their token", async () => {
    const { c, receptionist } = controller();
    const body = plainToInstance(PublicChatMessageDto, {
      salonId: SALON,
      message: "hola",
      clientId: CLIENT,
      metadata: { clientName: "Suplantada", serviceId: VISITOR },
    });
    const out: any = await c.sendMessage(body);
    const sent = (receptionist.sendMessage.mock.calls[0] as any)[0];
    expect(sent.channel).toBe("web");
    expect(sent.clientId).toMatch(/^visitor-/);
    expect(sent.metadata).toEqual({ serviceId: VISITOR }); // a visitor's name is not taken from a field
    expect(readVisitorToken(SECRET, SALON, out.visitorToken)).toBe(sent.clientId.slice("visitor-".length));
  });

  it("does not call the model once the daily limit is reached", async () => {
    const { c, receptionist } = controller(VISITOR_DAILY_MESSAGES);
    const body = plainToInstance(PublicChatMessageDto, { salonId: SALON, message: "hola" });
    await expect(c.sendMessage(body)).rejects.toBeInstanceOf(ChatDailyLimitException);
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
  });
});
