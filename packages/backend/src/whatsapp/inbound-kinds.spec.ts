import { metaInbound, telegramInbound, whatsAppInbound, mediaReply } from "./inbound-kinds";
import { EXAMPLE_VERIFY_TOKEN, WhatsAppService, verifyTokenUsable } from "./whatsapp.service";
import { sendChallenge } from "./whatsapp.controller";

/** Channels audit M10: what is answered, what gets the short media text, what is ignored. */
describe("inbound kinds", () => {
  it("WhatsApp: text, template buttons and interactive replies are text", () => {
    expect(whatsAppInbound({ type: "text", text: { body: "hola" } })).toEqual({ kind: "text", text: "hola" });
    expect(whatsAppInbound({ type: "button", button: { text: "Confirmar" } })).toEqual({ kind: "text", text: "Confirmar" });
    expect(whatsAppInbound({ type: "interactive", interactive: { list_reply: { title: "Mañana" } } })).toEqual({
      kind: "text",
      text: "Mañana",
    });
  });

  it("WhatsApp: voice notes, photos and files get the short reply; reactions, stickers and system messages nothing", () => {
    for (const type of ["audio", "image", "video", "document", "location", "contacts"]) {
      expect(whatsAppInbound({ type })).toEqual({ kind: "media" });
    }
    for (const type of ["reaction", "sticker", "system", "unsupported", "ephemeral", "whatever"]) {
      expect(whatsAppInbound({ type })).toEqual({ kind: "ignore" });
    }
    expect(whatsAppInbound({ type: "text", text: { body: "   " } })).toEqual({ kind: "ignore" });
  });

  it("Messenger/Instagram: the Get Started button is a hello, likes and story mentions are ignored", () => {
    expect(metaInbound({ postback: { payload: "GET_STARTED", title: "Empezar" } })).toEqual({ kind: "text", text: "Hola" });
    expect(metaInbound({ postback: { payload: "x", title: "Get Started" } })).toEqual({ kind: "text", text: "Hola" });
    expect(metaInbound({ postback: { payload: "PRICES", title: "Precios" } })).toEqual({ kind: "text", text: "Precios" });
    expect(metaInbound({ message: { mid: "m", sticker_id: 369239263222822, attachments: [{ type: "image" }] } })).toEqual({
      kind: "ignore",
    });
    expect(metaInbound({ message: { mid: "m", attachments: [{ type: "story_mention", payload: { url: "u" } }] } })).toEqual({
      kind: "ignore",
    });
    expect(metaInbound({ message: { mid: "m", is_unsupported: true } })).toEqual({ kind: "ignore" });
    expect(metaInbound({ reaction: { action: "react", emoji: "x" } })).toEqual({ kind: "ignore" });
    expect(metaInbound({ message: { mid: "m", attachments: [{ type: "audio" }] } })).toEqual({ kind: "media" });
    expect(metaInbound({ message: { mid: "m", text: "hola" } })).toEqual({ kind: "text", text: "hola" });
  });

  it("Telegram: stickers and other service messages are ignored", () => {
    expect(telegramInbound({ text: "hola" })).toEqual({ kind: "text", text: "hola" });
    expect(telegramInbound({ voice: { file_id: "x" } })).toEqual({ kind: "media" });
    expect(telegramInbound({ sticker: { file_id: "x" } })).toEqual({ kind: "ignore" });
    expect(telegramInbound({ new_chat_title: "x" })).toEqual({ kind: "ignore" });
  });

  it("the media reply offers the salon's phone when there is one", () => {
    expect(mediaReply("whatsapp", "910000000")).toBe(
      "No puedo escuchar audios ni ver fotos o archivos. Escríbeme lo que necesitas y te ayudo, o llama al salón al 910000000.",
    );
    expect(mediaReply("instagram", null)).toMatch(/el salón lo verá.*te ayudo\.$/);
  });
});

/** Channels audit M3: the webhook verification challenge. */
describe("webhook verification", () => {
  const service = (token?: string) =>
    new WhatsAppService(
      {} as any,
      {} as any,
      { get: (k: string) => (k === "META_WEBHOOK_VERIFY_TOKEN" ? token : undefined) } as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it("answers the challenge only for the right token, mode and a plain challenge", () => {
    const s = service("a-long-random-verify-value");
    expect(s.verifyChallenge("subscribe", "a-long-random-verify-value", "1158201444")).toBe("1158201444");
    expect(s.verifyChallenge("subscribe", "wrong", "1158201444")).toBeNull();
    expect(s.verifyChallenge("unsubscribe", "a-long-random-verify-value", "1158201444")).toBeNull();
    expect(s.verifyChallenge("subscribe", "a-long-random-verify-value", "<b>x</b>")).toBeNull();
    expect(s.verifyChallenge("subscribe", undefined, "1")).toBeNull();
    expect(s.verifyChallenge("subscribe", ["a"], "1")).toBeNull();
  });

  it("refuses everything while the verify token is unset or still the example value", () => {
    expect(service(undefined).verifyChallenge("subscribe", "", "1")).toBeNull();
    expect(service("").verifyChallenge("subscribe", "", "1")).toBeNull();
    expect(service(EXAMPLE_VERIFY_TOKEN).verifyChallenge("subscribe", EXAMPLE_VERIFY_TOKEN, "1")).toBeNull();
    expect(verifyTokenUsable("change_me_please")).toBe(false);
    expect(verifyTokenUsable("a-long-random-verify-value")).toBe(true);
  });

  it("sends the challenge as text/plain with nosniff, or a 403", () => {
    const res = () => {
      const r: any = { headers: {} as Record<string, string> };
      r.setHeader = jest.fn((k: string, v: string) => (r.headers[k] = v));
      r.type = jest.fn(() => r);
      r.status = jest.fn(() => r);
      r.send = jest.fn(() => r);
      return r;
    };
    const ok = res();
    sendChallenge(ok, "123");
    expect(ok.type).toHaveBeenCalledWith("text/plain");
    expect(ok.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(ok.status).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith("123");
    const no = res();
    sendChallenge(no, null);
    expect(no.status).toHaveBeenCalledWith(403);
    expect(no.send).toHaveBeenCalledWith("Forbidden");
  });
});
