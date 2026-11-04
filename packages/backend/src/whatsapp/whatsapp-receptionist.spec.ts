import { WhatsAppReceptionistService, toWhatsAppText } from "./whatsapp-receptionist.service";
import { OptOutNotRecordedError, WhatsAppService } from "./whatsapp.service";
import { RedisService } from "../common/cache/redis.service";

/** RedisService with nothing configured: its in-memory fallback, as in a test or dev box. */
const memoryRedis = () => new RedisService({ get: () => undefined } as any);

/**
 * WhatsApp messages to a salon's number used to be dropped (the webhook only
 * looked for opt-out words). They now reach the receptionist.
 */
function setup(over: { enabled?: boolean; reply?: any; active?: boolean; authErrorAt?: Date; redis?: RedisService; sendText?: any } = {}) {
  const prisma: any = {
    whatsAppConnection: {
      findUnique: jest.fn(async () => ({
        phoneNumberId: "pn1",
        accessTokenEnc: "enc",
        isActive: over.active ?? true,
        authErrorAt: over.authErrorAt ?? null,
      })),
    },
    tenant: { findUnique: jest.fn(async () => ({ phone: "+34 928 000 000" })) },
  };
  const meta: any = {
    decryptToken: jest.fn(() => "token"),
    sendText: over.sendText ?? jest.fn(async () => ({ messages: [{ id: "out" }] })),
    markRead: jest.fn(async () => undefined),
  };
  const flags: any = { isEnabled: jest.fn(async () => over.enabled ?? true) };
  const receptionist: any = {
    sendMessage: jest.fn(async () => over.reply ?? { id: "m1", content: "Tenemos hueco a las **10:00**." }),
  };
  const health: any = { whatsAppError: jest.fn(async () => true) };
  return {
    service: new WhatsAppReceptionistService(prisma, meta, flags, receptionist, over.redis ?? memoryRedis(), health),
    meta,
    receptionist,
    flags,
    health,
  };
}

const msg = (over: any = {}) => ({ id: "wamid.1", from: "34600111222", type: "text", text: "¿Tenéis hueco mañana?", ...over });

describe("WhatsAppReceptionistService", () => {
  it("passes the message to the receptionist with the sender's phone, and replies on WhatsApp", async () => {
    const { service, meta, receptionist } = setup();
    await service.enqueue("t1", msg({ profileName: "Ana" }));
    expect(receptionist.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "whatsapp-34600111222",
        salonId: "t1",
        channel: "whatsapp",
        message: "¿Tenéis hueco mañana?",
        metadata: { externalUserId: "+34600111222", clientPhone: "+34600111222", clientName: "Ana" },
      }),
    );
    expect(meta.sendText).toHaveBeenCalledWith("token", "pn1", "34600111222", "Tenemos hueco a las *10:00*.");
    expect(meta.markRead).toHaveBeenCalledWith("token", "pn1", "wamid.1");
  });

  it("handles a message Meta delivers twice only once", async () => {
    const { service, receptionist } = setup();
    await service.enqueue("t1", msg());
    await service.enqueue("t1", msg());
    expect(receptionist.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("remembers it across a restart or another instance: the record is in Redis, not in the process (M12)", async () => {
    const redis = memoryRedis();
    const first = setup({ redis });
    await first.service.enqueue("t1", msg());
    // A new process (after a deploy), same Redis.
    const second = setup({ redis });
    await second.service.enqueue("t1", msg());
    expect(first.receptionist.sendMessage).toHaveBeenCalledTimes(1);
    expect(second.receptionist.sendMessage).not.toHaveBeenCalled();
  });

  it("answers one sender's messages in the order they arrived", async () => {
    const order: string[] = [];
    const { service, receptionist } = setup();
    receptionist.sendMessage.mockImplementation(async (dto: any) => {
      await new Promise((r) => setTimeout(r, dto.message === "uno" ? 30 : 0));
      order.push(dto.message);
      return { id: "x", content: dto.message };
    });
    await Promise.all([service.enqueue("t1", msg({ id: "a", text: "uno" })), service.enqueue("t1", msg({ id: "b", text: "dos" }))]);
    expect(order).toEqual(["uno", "dos"]);
  });

  it("stays silent when the salon has no receptionist or no active connection", async () => {
    const off = setup({ enabled: false });
    await off.service.enqueue("t1", msg());
    expect(off.receptionist.sendMessage).not.toHaveBeenCalled();
    expect(off.meta.sendText).not.toHaveBeenCalled();

    const inactive = setup({ active: false });
    await inactive.service.enqueue("t1", msg());
    expect(inactive.meta.sendText).not.toHaveBeenCalled();
  });

  it("answers a voice note or a photo with a short text: write, or call the salon (M10)", async () => {
    const { service, meta, receptionist } = setup();
    await service.enqueue("t1", msg({ type: "media", text: undefined }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(meta.sendText.mock.calls[0][3]).toBe(
      "No puedo escuchar audios ni ver fotos o archivos. Escríbeme lo que necesitas y te ayudo, o llama al salón al +34 928 000 000.",
    );
  });

  it("spends no AI while Meta refuses the salon's token (M5)", async () => {
    const { service, meta, receptionist } = setup({ authErrorAt: new Date() });
    await service.enqueue("t1", msg());
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(meta.sendText).not.toHaveBeenCalled();
  });

  it("a reply Meta refuses for the token marks the connection (M5)", async () => {
    const { service, health } = setup({
      sendText: jest.fn(async () => ({ error: { code: 190, message: "Session has expired" } })),
    });
    await service.enqueue("t1", msg());
    expect(health.whatsAppError).toHaveBeenCalledWith("t1", 190);
  });

  it("apologises with the salon's phone when the receptionist fails", async () => {
    const { service, meta } = setup({ reply: { id: "error-response", content: "" } });
    await service.enqueue("t1", msg());
    expect(meta.sendText.mock.calls[0][3]).toContain("+34 928 000 000");
  });

  it("caps how many messages one sender can trigger in an hour, across restarts (M12)", async () => {
    const redis = memoryRedis();
    const { service, receptionist } = setup({ redis });
    for (let i = 0; i < 20; i++) await service.enqueue("t1", msg({ id: `m${i}` }));
    const restarted = setup({ redis });
    for (let i = 20; i < 35; i++) await restarted.service.enqueue("t1", msg({ id: `m${i}` }));
    expect(receptionist.sendMessage.mock.calls.length + restarted.receptionist.sendMessage.mock.calls.length).toBe(30);
  });
});

describe("toWhatsAppText", () => {
  it("turns Markdown into WhatsApp formatting", () => {
    expect(toWhatsAppText("## Resumen\n**Servicio:** Corte\n- [Web](https://x.test)")).toBe(
      "Resumen\n*Servicio:* Corte\n- Web: https://x.test",
    );
  });
});

describe("WhatsApp webhook routing", () => {
  function service(over: { optOutUpsert?: any; consent?: any } = {}) {
    const receptionist: any = { enqueue: jest.fn(async () => undefined) };
    const optOuts = new Map<string, any>();
    const prisma: any = {
      client: { findFirst: jest.fn(async () => null) },
      whatsAppCampaignRecipient: { findFirst: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 1 })) },
      // The client file says "600 111 222"; Meta sends "34600111222".
      $queryRaw: jest.fn(async () => [{ id: "c1" }]),
      whatsAppOptOut: {
        upsert: jest.fn(
          over.optOutUpsert ??
            (async (args: any) => {
              const key = `${args.where.tenantId_messageId.tenantId}:${args.where.tenantId_messageId.messageId}`;
              if (!optOuts.has(key)) {
                optOuts.set(key, { id: `o${optOuts.size + 1}`, processedAt: null, attempts: 0, ...args.create });
              }
              return optOuts.get(key);
            }),
        ),
        update: jest.fn(async (args: any) => {
          const row = [...optOuts.values()].find((r) => r.id === args.where.id);
          const data = { ...args.data };
          if (data.attempts?.increment) data.attempts = row.attempts + data.attempts.increment;
          Object.assign(row, data);
          return row;
        }),
        findMany: jest.fn(async () => [...optOuts.values()].filter((r) => !r.processedAt)),
      },
    };
    const consent: any = over.consent ?? { recordMarketingChoice: jest.fn(async () => ({ status: "refused" })) };
    const s = new WhatsAppService(prisma, {} as any, {} as any, consent, receptionist, {} as any);
    return { s, receptionist, prisma, consent, optOuts };
  }
  const change = (body: string, message: any = {}) => ({
    value: {
      contacts: [{ wa_id: "34600111222", profile: { name: "Ana" } }],
      messages: [{ id: "wamid.9", from: "34600111222", type: "text", text: { body }, ...message }],
    },
  });

  it("sends ordinary texts, \"cancelar\" included, to the receptionist", async () => {
    const { s, receptionist } = service();
    await (s as any).handleChange("t1", change("Quiero cancelar mi cita"));
    await (s as any).handleChange("t1", change("cancelar"));
    expect(receptionist.enqueue).toHaveBeenCalledTimes(2);
    expect(receptionist.enqueue.mock.calls[0][1]).toMatchObject({ from: "34600111222", profileName: "Ana" });
  });

  it("keeps BAJA / STOP as the opt-out words: WhatsApp promotions are withdrawn", async () => {
    const { s, receptionist, prisma, consent } = service();
    await (s as any).handleChange("t1", change("BAJA"));
    expect(receptionist.enqueue).not.toHaveBeenCalled();
    // Matched on the last nine digits, not by substring.
    const sql = prisma.$queryRaw.mock.calls[0];
    expect(sql.slice(1)).toEqual(["t1", "600111222"]);
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith({
      tenantId: "t1",
      clientId: "c1",
      accepts: false,
      channel: "whatsapp",
    });
    // Only messages still waiting are stopped; sent ones keep their status.
    expect(prisma.whatsAppCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { clientId: "c1", status: "pending" },
      data: { status: "opted_out" },
    });
  });

  it("writes the BAJA down before anything else, and clears the number once applied (M11)", async () => {
    const { s, prisma, optOuts } = service();
    await (s as any).handleChange("t1", change("BAJA"));
    expect(prisma.whatsAppOptOut.upsert).toHaveBeenCalledWith({
      where: { tenantId_messageId: { tenantId: "t1", messageId: "wamid.9" } },
      create: { tenantId: "t1", messageId: "wamid.9", phone: "34600111222" },
      update: {},
    });
    expect(prisma.whatsAppOptOut.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[0],
    );
    expect([...optOuts.values()][0]).toMatchObject({ processedAt: expect.any(Date), clientsFound: 1, phone: "" });
  });

  it("Meta delivering the same BAJA again changes nothing (M11)", async () => {
    const { s, consent } = service();
    await (s as any).handleChange("t1", change("BAJA"));
    await (s as any).handleChange("t1", change("BAJA"));
    expect(consent.recordMarketingChoice).toHaveBeenCalledTimes(1);
  });

  it("if the BAJA cannot even be written, the webhook fails so Meta retries it (M11)", async () => {
    const { s } = service({
      optOutUpsert: async () => {
        throw new Error("db down");
      },
    });
    await expect((s as any).handleChange("t1", change("BAJA"))).rejects.toBeInstanceOf(OptOutNotRecordedError);
  });

  it("a BAJA whose consent could not be recorded stays pending and the sweep applies it (M11)", async () => {
    const consent = {
      recordMarketingChoice: jest
        .fn()
        .mockRejectedValueOnce(new Error("deadlock"))
        .mockResolvedValue({ status: "refused" }),
    };
    const { s, optOuts } = service({ consent });
    await (s as any).handleChange("t1", change("BAJA"));
    const row = [...optOuts.values()][0];
    expect(row).toMatchObject({ processedAt: null, attempts: 1, lastError: "deadlock", phone: "34600111222" });
    expect(await s.retryPendingOptOuts()).toBe(1);
    expect(row.processedAt).toBeInstanceOf(Date);
    expect(consent.recordMarketingChoice).toHaveBeenCalledTimes(2);
  });

  it("ignores reactions, stickers, system and unsupported messages: no reply, no AI (M10)", async () => {
    const { s, receptionist } = service();
    for (const type of ["reaction", "sticker", "system", "unsupported"]) {
      await (s as any).handleChange("t1", change("", { type, text: undefined, id: `w-${type}` }));
    }
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it("passes a voice note on as media, and a reminder's quick-reply button as its text (M10)", async () => {
    const { s, receptionist } = service();
    await (s as any).handleChange("t1", change("", { type: "audio", text: undefined, id: "w-a" }));
    await (s as any).handleChange("t1", change("", { type: "button", text: undefined, button: { text: "Confirmar" }, id: "w-b" }));
    expect(receptionist.enqueue.mock.calls[0][1]).toMatchObject({ type: "media", text: undefined });
    expect(receptionist.enqueue.mock.calls[1][1]).toMatchObject({ type: "text", text: "Confirmar" });
  });
});
