import { optOutIntent } from "./opt-out-words";
import { WhatsAppService } from "./whatsapp.service";

/**
 * BAJA only worked as the exact, whole message: "Baja.", "Quiero darme de
 * baja" or "STOP!" went to the receptionist and the promotions kept coming.
 */
describe("WhatsApp opt-out words", () => {
  it.each([
    "baja",
    "BAJA",
    "Baja.",
    "  baja!! ",
    "stop",
    "STOP",
    "unsubscribe",
    "Quiero darme de baja",
    "quiero darme de BAJA por favor",
    "Hola, baja por favor",
    "Dame de baja",
    "dadme de baja de las promociones, gracias",
  ])("%p asks to stop, and is only that", (body) => {
    expect(optOutIntent(body)).toEqual({ optOut: true, only: true });
  });

  it.each([
    "bajada",
    "rebaja",
    "¿Tenéis rebajas este mes?",
    "La bajada de precios está genial",
    "Estoy de baja y no puedo ir el martes",
    "estoy de baja médica, ¿podemos cambiar la cita?",
    "Mi hija está de baja por maternidad",
    "tengo la baja laboral hasta el lunes",
    "Quiero cancelar mi cita",
    "",
  ])("%p is not a request to stop", (body) => {
    expect(optOutIntent(body).optOut).toBe(false);
  });

  it("a request with a question in it is still a request, and not only that", () => {
    expect(optOutIntent("Baja de las promociones. ¿Y mi cita del martes sigue en pie?")).toEqual({ optOut: true, only: false });
  });
});

describe("WhatsApp webhook: opt-out words anywhere", () => {
  function service() {
    const receptionist: any = { enqueue: jest.fn(async () => undefined) };
    const prisma: any = {
      whatsAppCampaignRecipient: { findFirst: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 1 })) },
      $queryRaw: jest.fn(async () => [{ id: "c1" }]),
    };
    const consent: any = { recordMarketingChoice: jest.fn(async () => ({ status: "refused" })) };
    const s = new WhatsAppService(prisma, {} as any, {} as any, consent, receptionist, {} as any);
    return { s, receptionist, consent };
  }
  const change = (body: string) => ({
    value: { messages: [{ id: "wamid.1", from: "34600111222", type: "text", text: { body } }] },
  });

  it("\"Quiero darme de baja.\" withdraws WhatsApp promotions and is not sent to the receptionist", async () => {
    const { s, receptionist, consent } = service();
    await (s as any).handleChange("t1", change("Quiero darme de baja."));
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "c1", accepts: false, channel: "whatsapp" }),
    );
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it("an opt-out with a question also gets the question answered", async () => {
    const { s, receptionist, consent } = service();
    await (s as any).handleChange("t1", change("Baja de promociones, y quiero cambiar mi cita del martes"));
    expect(consent.recordMarketingChoice).toHaveBeenCalled();
    expect(receptionist.enqueue).toHaveBeenCalledTimes(1);
  });

  it("\"rebaja\" and sick leave go to the receptionist without unsubscribing anyone", async () => {
    const { s, receptionist, consent } = service();
    await (s as any).handleChange("t1", change("¿Hay rebaja en el tinte?"));
    await (s as any).handleChange("t1", change("Estoy de baja, ¿puedo pasar la cita al viernes?"));
    expect(consent.recordMarketingChoice).not.toHaveBeenCalled();
    expect(receptionist.enqueue).toHaveBeenCalledTimes(2);
  });
});
