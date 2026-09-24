import { getDynamicContext, getSystemPrompt } from "./templates";

/**
 * L4: the system prompt must be byte-stable for a given salon.
 *
 * Provider-side prompt caching is a prefix match, so a single volatile
 * character anywhere in the system prompt means nothing is ever cached.
 * That is exactly what happened: the prompt interpolated
 * `new Date().toISOString()`, so it differed on every request and the
 * cache could not hit even once. The datetime now rides on the user turn.
 *
 * These assertions are cheap and they are what stops the next volatile
 * value from silently costing 10x on input tokens.
 */
const salonContext = {
  salonName: "Salón Prueba",
  salonAddress: "Calle Mayor 1",
  salonPhone: "600000000",
  salonWhatsapp: "600000000",
  salonEmail: "hola@salon.test",
  salonTimezone: "Europe/Madrid",
  salonHours: "- lunes: 09:00–19:00",
  cancellationPolicy: "24 horas",
  minCancelHours: 24,
  services: [
    { name: "Corte", category: "hair", duration: 30, price: 20, currency: "EUR" },
  ],
  professionals: [
    { full_name: "Ana A", position: "estilista", specialties: "color" },
  ],
  faqs: [{ question: "¿Aparcáis?", answer: "Hay parking en la plaza." }],
};

describe("system prompt cache prefix", () => {
  it("is identical across calls with the same salon", () => {
    const first = getSystemPrompt("es", "Salón Prueba", "Kira") + getDynamicContext("es", salonContext);
    const second = getSystemPrompt("es", "Salón Prueba", "Kira") + getDynamicContext("es", salonContext);
    expect(second).toBe(first);
  });

  it("carries no timestamp, date or clock value", () => {
    const prompt = getSystemPrompt("es", "Salón Prueba", "Kira") + getDynamicContext("es", salonContext);
    // ISO instants, ISO dates and bare clock times all invalidate the prefix.
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The opening-hours line legitimately contains times, so only flag a
    // clock value that is not part of an hours range.
    const withoutHours = prompt.replace(/\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}/g, "");
    expect(withoutHours).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
  });

  it("stays stable for the English prompt too", () => {
    const first = getSystemPrompt("en", "Salón Prueba", "Kira") + getDynamicContext("en", salonContext);
    const second = getSystemPrompt("en", "Salón Prueba", "Kira") + getDynamicContext("en", salonContext);
    expect(second).toBe(first);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("does change when the salon's own data changes", () => {
    const base = getDynamicContext("es", salonContext);
    const renamed = getDynamicContext("es", { ...salonContext, salonName: "Otro Salón" });
    expect(renamed).not.toBe(base);
  });
});
