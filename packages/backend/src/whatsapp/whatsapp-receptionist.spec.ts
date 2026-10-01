import { WhatsAppReceptionistService, toWhatsAppText } from "./whatsapp-receptionist.service";
import { WhatsAppService } from "./whatsapp.service";

/**
 * WhatsApp messages to a salon's number used to be dropped (the webhook only
 * looked for opt-out words). They now reach the receptionist.
 */
function setup(over: { enabled?: boolean; reply?: any; active?: boolean } = {}) {
  const prisma: any = {
    whatsAppConnection: {
      findUnique: jest.fn(async () => ({ phoneNumberId: "pn1", accessTokenEnc: "enc", isActive: over.active ?? true })),
    },
    tenant: { findUnique: jest.fn(async () => ({ phone: "+34 928 000 000" })) },
  };
  const meta: any = {
    decryptToken: jest.fn(() => "token"),
    sendText: jest.fn(async () => ({ messages: [{ id: "out" }] })),
    markRead: jest.fn(async () => undefined),
  };
  const flags: any = { isEnabled: jest.fn(async () => over.enabled ?? true) };
  const receptionist: any = {
    sendMessage: jest.fn(async () => over.reply ?? { id: "m1", content: "Tenemos hueco a las **10:00**." }),
  };
  return { service: new WhatsAppReceptionistService(prisma, meta, flags, receptionist), meta, receptionist, flags };
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

  it("says it only reads text when sent audio or images", async () => {
    const { service, meta, receptionist } = setup();
    await service.enqueue("t1", msg({ type: "audio", text: undefined }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(meta.sendText.mock.calls[0][3]).toMatch(/solo puedo leer mensajes de texto/);
  });

  it("apologises with the salon's phone when the receptionist fails", async () => {
    const { service, meta } = setup({ reply: { id: "error-response", content: "" } });
    await service.enqueue("t1", msg());
    expect(meta.sendText.mock.calls[0][3]).toContain("+34 928 000 000");
  });

  it("caps how many messages one sender can trigger in an hour", async () => {
    const { service, receptionist } = setup();
    for (let i = 0; i < 35; i++) await service.enqueue("t1", msg({ id: `m${i}` }));
    expect(receptionist.sendMessage).toHaveBeenCalledTimes(30);
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
  function service() {
    const receptionist: any = { enqueue: jest.fn(async () => undefined) };
    const prisma: any = {
      client: { findFirst: jest.fn(async () => null) },
      whatsAppCampaignRecipient: { findFirst: jest.fn(async () => null) },
    };
    const s = new WhatsAppService(prisma, {} as any, {} as any, {} as any, receptionist);
    return { s, receptionist, prisma };
  }
  const change = (body: string) => ({
    value: {
      contacts: [{ wa_id: "34600111222", profile: { name: "Ana" } }],
      messages: [{ id: "wamid.9", from: "34600111222", type: "text", text: { body } }],
    },
  });

  it("sends ordinary texts, \"cancelar\" included, to the receptionist", async () => {
    const { s, receptionist } = service();
    await (s as any).handleChange("t1", change("Quiero cancelar mi cita"));
    await (s as any).handleChange("t1", change("cancelar"));
    expect(receptionist.enqueue).toHaveBeenCalledTimes(2);
    expect(receptionist.enqueue.mock.calls[0][1]).toMatchObject({ from: "34600111222", profileName: "Ana" });
  });

  it("keeps BAJA / STOP as the opt-out words", async () => {
    const { s, receptionist, prisma } = service();
    await (s as any).handleChange("t1", change("BAJA"));
    expect(receptionist.enqueue).not.toHaveBeenCalled();
    expect(prisma.client.findFirst).toHaveBeenCalled();
  });
});
