import { ConfigService } from "@nestjs/config";
import { LLMService } from "./llm.service";
import { SALON_TOOLS } from "../tools/salon-tools";

/**
 * The receptionist has to be able to answer a salon's FAQs.
 *
 * It could not. `buildSystemPrompt` loaded them from the FAQ service, capped
 * them at 20 entries, truncated each question and answer to 200 characters —
 * and then passed `faqs: []` to the template, throwing all of that away. The
 * rendered prompt always said "No FAQs available".
 *
 * There was no fallback either: SALON_TOOLS exposes list_services,
 * get_service, list_professionals, check_availability and get_salon_info.
 * Nothing retrieves FAQs. So a salon could enter them through
 * `POST /virtual-receptionist/faqs`, see them saved, and the assistant would
 * still know nothing about them.
 *
 * Services and professionals stay OUT of the prompt on purpose — the model
 * must call the tools for those, and the L-1 e2e suite checks that it does.
 * FAQs are the opposite case: static reference text with no tool behind it.
 */

function buildService(): LLMService {
  const configService = {
    get: (): undefined => undefined,
  } as unknown as ConfigService;
  const stub = {} as any;

  // Only buildSystemPrompt is under test, and it touches none of these.
  return new LLMService(stub, configService, stub, stub, stub, stub, stub);
}

function promptFor(context: Record<string, unknown>): string {
  const service = buildService();
  return (service as any).buildSystemPrompt(context);
}

const BASE = {
  id: "tenant-1",
  name: "Salon Prueba",
  language: "es",
  assistantName: "Kira",
  timezone: "Atlantic/Canary",
  minCancelHours: 24,
};

describe("buildSystemPrompt includes the salon's FAQs", () => {
  it("renders a FAQ's question and answer", () => {
    const prompt = promptFor({
      ...BASE,
      faqs: [
        {
          question: "¿Hay que dejar señal para reservar?",
          answer: "No, no pedimos señal para ninguna cita.",
        },
      ],
    });

    expect(prompt).toContain("¿Hay que dejar señal para reservar?");
    expect(prompt).toContain("No, no pedimos señal para ninguna cita.");
  });

  it("stops saying there are no FAQs when there are some", () => {
    const prompt = promptFor({
      ...BASE,
      faqs: [{ question: "¿Tenéis parking?", answer: "Sí, en la misma calle." }],
    });

    expect(prompt).not.toContain("No FAQs available");
  });

  it("renders every FAQ, not just the first", () => {
    const faqs = [
      { question: "¿Tenéis parking?", answer: "Sí." },
      { question: "¿Aceptáis tarjeta?", answer: "Sí, y Bizum." },
      { question: "¿Hacéis uñas?", answer: "Todavía no." },
    ];

    const prompt = promptFor({ ...BASE, faqs });

    for (const faq of faqs) {
      expect(prompt).toContain(faq.question);
      expect(prompt).toContain(faq.answer);
    }
  });

  it("caps the list at 20 so a salon with hundreds cannot blow the prompt", () => {
    const faqs = Array.from({ length: 50 }, (_, i) => ({
      question: `Pregunta numero ${i}`,
      answer: `Respuesta numero ${i}`,
    }));

    const prompt = promptFor({ ...BASE, faqs });

    expect(prompt).toContain("Pregunta numero 19");
    expect(prompt).not.toContain("Pregunta numero 20");
    expect(prompt).not.toContain("Pregunta numero 49");
  });

  it("truncates a long question and answer to 200 characters", () => {
    const long = "a".repeat(500);
    const prompt = promptFor({
      ...BASE,
      faqs: [{ question: long, answer: long }],
    });

    expect(prompt).toContain("a".repeat(200));
    expect(prompt).not.toContain("a".repeat(201));
  });

  it("says there are none when the salon has none", () => {
    expect(promptFor({ ...BASE, faqs: [] })).toContain("No FAQs available");
  });

  it("survives a context with no faqs field at all", () => {
    expect(() => promptFor({ ...BASE })).not.toThrow();
  });

  it("still keeps services and professionals out of the prompt", () => {
    // The tool-grounding decision this fix must not quietly reverse.
    const prompt = promptFor({
      ...BASE,
      services: [
        { name: "Corte de pelo mujer", duration: 30, price: 30, category: "hair" },
      ],
      professionals: [{ firstName: "Carla", lastName: "Santana" }],
      faqs: [],
    });

    expect(prompt).not.toContain("Corte de pelo mujer");
    expect(prompt).not.toContain("Carla");
  });
});

describe("no tool retrieves FAQs, so the prompt is their only route", () => {
  it("SALON_TOOLS has no FAQ tool", () => {
    // If one is ever added, revisit whether the prompt copy is still wanted:
    // a tool costs a round-trip per question, the prompt costs nothing extra.
    const names = SALON_TOOLS.map((t: { name: string }) => t.name);

    expect(names).toEqual([
      "list_services",
      "get_service",
      "list_professionals",
      "check_availability",
      "propose_appointment",
      "create_appointment",
      "get_salon_info",
    ]);
    expect(names.some((n: string) => /faq/i.test(n))).toBe(false);
  });
});
