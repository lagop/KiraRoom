import { getDynamicContext, getSystemPrompt } from "./templates";
import { SALON_TOOLS } from "../tools/salon-tools";
import { ConfigService } from "@nestjs/config";
import { LLMService } from "../services/llm.service";

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
 * The prefix is tools + system, in that order. These cases measure the system
 * prompt LLMService.buildSystemPrompt actually sends. An earlier version
 * rebuilt it from getSystemPrompt + getDynamicContext, and when the booking
 * flow was appended to the real prompt that copy did not follow: it kept
 * reporting ~1970 tokens while the real prefix was nearer 3600.
 *
 * The size is not the same for every salon either: the FAQs are in the
 * prompt, up to 20 entries of 200 + 200 characters. Both ends are pinned
 * below. They are tripwires, not goals: when one fails, the prompt has moved
 * relative to the line — re-read per-tenant cache_read_input_tokens in
 * production and correct the cost model, which currently has to assume no
 * caching at all.
 */
describe("cache prefix length against the model minimum", () => {
  // Haiku 4.5. Sonnet and Opus cache from 1024. Haiku 3.5 was 2048, which is
  // the figure to not confuse this with.
  const HAIKU_4_5_MINIMUM_TOKENS = 4096;

  // Deliberately rough. Spanish prose runs ~3.6 chars per token; the tool
  // schemas are English JSON and tokenise closer to ~4.2. Within about 15% of
  // the line this estimate cannot decide which side a prompt is on.
  const SPANISH_CHARS_PER_TOKEN = 3.6;
  const JSON_CHARS_PER_TOKEN = 4.2;
  const UNDECIDABLE_BAND = 0.15;

  function realSystemPrompt(faqs: Array<{ question: string; answer: string }>): string {
    const configService = { get: (): undefined => undefined } as unknown as ConfigService;
    const stub = {} as any;
    const service = new LLMService(stub, configService, stub, stub, stub, stub, stub);
    return (service as any).buildSystemPrompt({
      id: "tenant-1",
      name: "Salón Prueba",
      assistantName: "Kira",
      timezone: "Europe/Madrid",
      language: "es",
      minCancelHours: 24,
      workingHours: { monday: { start: "09:00", end: "19:00" } },
      faqs,
    });
  }

  function ratioToMinimum(system: string): number {
    const tokens =
      JSON.stringify(SALON_TOOLS).length / JSON_CHARS_PER_TOKEN +
      system.length / SPANISH_CHARS_PER_TOKEN;
    return tokens / HAIKU_4_5_MINIMUM_TOKENS;
  }

  it("measures the prompt that is really sent, booking flow included", () => {
    // Guards against the measurement drifting from production again.
    expect(realSystemPrompt([])).toContain("ETAPA: CONFIRMATION");
  });

  it("puts a salon without FAQs where only production can tell", () => {
    // ~3600 estimated at the time of writing: 88% of the minimum. Leaving
    // this band either way means the answer for small salons has changed.
    const ratio = ratioToMinimum(realSystemPrompt([]));
    expect(ratio).toBeGreaterThan(1 - UNDECIDABLE_BAND);
    expect(ratio).toBeLessThan(1 + UNDECIDABLE_BAND);
  });

  it("puts a salon with a full set of FAQs clearly over the minimum", () => {
    // 20 entries at the 200-character caps buildSystemPrompt applies.
    const full = Array.from({ length: 20 }, (_, i) => ({
      question: `${i} ${"q".repeat(198)}`,
      answer: `${i} ${"a".repeat(198)}`,
    }));
    expect(ratioToMinimum(realSystemPrompt(full))).toBeGreaterThan(1 + UNDECIDABLE_BAND);
  });
});
