import { getDynamicContext, getSystemPrompt } from "./templates";
import { SALON_TOOLS } from "../tools/salon-tools";

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

/**
 * Stability is necessary but not sufficient: the prefix also has to be long
 * enough for the model to cache it at all.
 *
 * Claude Haiku 4.5 will not cache a prefix under 4096 tokens, and it returns
 * NO error when it declines — the request is simply processed uncached. That
 * is why production showed cache_read_input_tokens at 0 for every call while
 * the prompt was stable and `cache_control` was set correctly.
 *
 * The prefix is tools + system, in that order. Measured on the real prompt:
 * ~620 tokens of tool schemas plus ~1360 of system prompt, about 1970 — under
 * half the minimum. And it cannot grow into the limit on its own, because
 * buildSystemPrompt deliberately keeps services and professionals out, so the
 * prompt is the same size for every salon whatever its data.
 *
 * This case exists to notice if that ever changes. If it fails because the
 * prompt grew, that is good news, not a regression: check whether
 * cache_read_input_tokens has started moving in production, and correct the
 * cost model, which currently has to assume no caching at all.
 */
describe("cache prefix length against the model minimum", () => {
  // Haiku 4.5. Sonnet and Opus cache from 1024. Haiku 3.5 was 2048, which is
  // the figure to not confuse this with.
  const HAIKU_4_5_MINIMUM_TOKENS = 4096;

  // Deliberately rough: the point is the order of magnitude, not a precise
  // count, and the gap is a factor of two. Spanish prose runs ~3.6 chars per
  // token; the tool schemas are English JSON and tokenise closer to ~4.2.
  const SPANISH_CHARS_PER_TOKEN = 3.6;
  const JSON_CHARS_PER_TOKEN = 4.2;

  function estimatedPrefixTokens(): number {

    // What buildSystemPrompt actually sends: services and professionals empty.
    const system =
      getSystemPrompt("es", "Salón Prueba", "Kira") +
      getDynamicContext("es", { ...salonContext, services: [], professionals: [] });

    return Math.round(
      JSON.stringify(SALON_TOOLS).length / JSON_CHARS_PER_TOKEN +
        system.length / SPANISH_CHARS_PER_TOKEN,
    );
  }

  it("is still below the minimum, so caching is inert", () => {
    expect(estimatedPrefixTokens()).toBeLessThan(HAIKU_4_5_MINIMUM_TOKENS);
  });

  it("is not so close to the minimum that the estimate decides it", () => {
    // If the prefix ever lands within 15% of the line, the char-per-token
    // estimate is no longer good enough to tell — go and read
    // cache_read_input_tokens from a real pair of requests instead.
    const ratio = estimatedPrefixTokens() / HAIKU_4_5_MINIMUM_TOKENS;
    expect(ratio).toBeLessThan(0.85);
  });
});
