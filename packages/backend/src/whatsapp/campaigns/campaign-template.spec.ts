import {
  CAMPAIGN_FOOTER,
  MAX_BODY_LENGTH,
  attemptOf,
  campaignTemplatePayload,
  compileBody,
  templateNameFor,
  withinSendingHours,
} from "./campaign-template";

/**
 * A campaign's text becomes a Meta MARKETING template. These pin the rules
 * Meta applies to template bodies, so the salon hears about a problem when
 * it writes the message instead of after a day waiting for Meta's review.
 */
describe("compileBody", () => {
  it("turns {{nombre}} into Meta's {{1}}", () => {
    expect(compileBody("Hola {{nombre}}, este mes 20 % en mechas.")).toEqual({
      text: "Hola {{1}}, este mes 20 % en mechas.",
      usesName: true,
    });
    expect(compileBody("Hola {{ Nombre }}, ¡vuelve!")).toEqual({ text: "Hola {{1}}, ¡vuelve!", usesName: true });
    expect(compileBody("  Promoción de otoño  ")).toEqual({ text: "Promoción de otoño", usesName: false });
  });

  it.each([
    ["", "Escribe el mensaje"],
    ["{{nombre}}, vuelve pronto", "no puede empezar ni terminar"],
    ["Te esperamos, {{nombre}}", "no puede empezar ni terminar"],
    ["Hola {{nombre}} y {{nombre}}!", "una sola vez"],
    ["Hola {{apellido}}!", "único marcador"],
    ["Hola {{nombre}}, código {{1}} hoy", "único marcador"],
    ["Hola\n\n\n\nadiós", "línea en blanco"],
    ["x".repeat(MAX_BODY_LENGTH + 1), "caracteres"],
  ])("refuses %j", (raw, message) => {
    const result = compileBody(raw);
    expect("error" in result && result.error).toContain(message);
  });
});

describe("campaign template", () => {
  it("is MARKETING, in Spanish, with the BAJA footer and an example for the name", () => {
    const payload = campaignTemplatePayload("kr_promo_abc_1", { text: "Hola {{1}}, 20 % hoy.", usesName: true });
    expect(payload).toEqual({
      name: "kr_promo_abc_1",
      language: "es",
      category: "MARKETING",
      components: [
        { type: "BODY", text: "Hola {{1}}, 20 % hoy.", example: { body_text: [["Ana"]] } },
        { type: "FOOTER", text: CAMPAIGN_FOOTER },
      ],
    });
    // Meta caps footers at 60 characters, and the webhook understands "BAJA".
    expect(CAMPAIGN_FOOTER.length).toBeLessThanOrEqual(60);
    expect(CAMPAIGN_FOOTER).toContain("BAJA");
  });

  it("has no example when the text has no variable", () => {
    const body = campaignTemplatePayload("n", { text: "Promoción", usesName: false }).components[0];
    expect(body).toEqual({ type: "BODY", text: "Promoción" });
  });

  it("gets a valid, new name for every submission", () => {
    const first = templateNameFor("3f2a9c1e-77b1-4c2d-9e10-aa55cc66dd77", 1);
    expect(first).toBe("kr_promo_3f2a9c1e77b1_1");
    expect(first).toMatch(/^[a-z0-9_]+$/);
    expect(attemptOf(first)).toBe(1);
    expect(attemptOf("")).toBe(0);
    expect(templateNameFor("3f2a9c1e-77b1-4c2d-9e10-aa55cc66dd77", attemptOf(first) + 1)).toBe("kr_promo_3f2a9c1e77b1_2");
  });
});

describe("withinSendingHours", () => {
  it("is 9:00 to 21:00 in the salon's own time zone", () => {
    expect(withinSendingHours(new Date("2026-10-10T07:00:00Z"), "Europe/Madrid")).toBe(true); // 9:00
    expect(withinSendingHours(new Date("2026-10-10T06:59:00Z"), "Europe/Madrid")).toBe(false); // 8:59
    expect(withinSendingHours(new Date("2026-10-10T19:00:00Z"), "Europe/Madrid")).toBe(false); // 21:00
    expect(withinSendingHours(new Date("2026-10-10T07:30:00Z"), "Atlantic/Canary")).toBe(false); // 8:30
    expect(withinSendingHours(new Date("2026-10-10T12:00:00Z"), "Not/AZone")).toBe(true); // falls back to Madrid
  });
});
