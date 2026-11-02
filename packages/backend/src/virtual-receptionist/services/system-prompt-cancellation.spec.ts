import { ConfigService } from "@nestjs/config";
import { LLMService } from "./llm.service";
import { cancellationPolicyLines, lateCancellationLine } from "../prompts/templates";

/**
 * The cancellation policy the receptionist is told about.
 *
 * It is informational: clients cancel by telling the salon and nothing in
 * KiraRoom charges a fee. "Sin política" (0 hours) used to become 24 h
 * through `|| 24`, so the receptionist asked for notice the salon never set,
 * and the salon's own policy text (Tenant.cancellationPolicy) could not be
 * edited anywhere, so it was always "Contact the salon".
 */

function promptFor(context: Record<string, unknown>): string {
  const configService = { get: (): undefined => undefined } as unknown as ConfigService;
  const stub = {} as any;
  const service = new LLMService(stub, configService, stub, stub, stub, stub, stub);
  return (service as any).buildSystemPrompt(context);
}

const BASE = { id: "tenant-1", name: "Salón Prueba", assistantName: "Kira", timezone: "Europe/Madrid", faqs: [] };

describe("the receptionist's cancellation policy", () => {
  it("0 hours is 'sin política', never 24", () => {
    const prompt = promptFor({ ...BASE, language: "es", minCancelHours: 0 });
    expect(prompt).toContain("Aviso mínimo para cancelar: sin política (no hay plazo mínimo).");
    expect(prompt).toContain("El salón no pide un plazo mínimo");
    expect(prompt).not.toMatch(/24 horas/);
    expect(prompt).not.toContain("{{");
  });

  it("uses the salon's hours when it set some", () => {
    const prompt = promptFor({ ...BASE, language: "es", minCancelHours: 48 });
    expect(prompt).toContain("Aviso que pide el salón para cancelar: 48 horas antes de la cita.");
    expect(prompt).toContain("Si faltan menos de 48 horas");
    expect(prompt).not.toMatch(/24 horas/);
  });

  it("quotes the salon's own text, and says none is written when there is none", () => {
    const withText = promptFor({
      ...BASE,
      language: "es",
      minCancelHours: 24,
      cancellationPolicy: "Si no puedes venir,\n avísanos por WhatsApp.",
    });
    expect(withText).toContain('Política de cancelación (la escribe el salón, es informativa): "Si no puedes venir, avísanos por WhatsApp."');
    const without = promptFor({ ...BASE, language: "es", minCancelHours: 24 });
    expect(without).toContain("Política de cancelación: sin política escrita.");
    expect(without).not.toContain("Contact the salon");
  });

  it("tells the receptionist nothing is charged automatically", () => {
    expect(promptFor({ ...BASE, language: "es", minCancelHours: 24 })).toContain("KiraRoom no cobra nada por cancelar");
    expect(promptFor({ ...BASE, language: "en", minCancelHours: 24 })).toContain("KiraRoom charges nothing for cancelling");
  });

  it("the salon's text is not scanned for placeholders", () => {
    const prompt = promptFor({ ...BASE, language: "es", phone: "600000000", cancellationPolicy: "Llama al {{SALON_PHONE}} $&" });
    expect(prompt).toContain('"Llama al {{SALON_PHONE}} $&"');
  });

  it("English: the same rules, and no promise of a client account", () => {
    const prompt = promptFor({ ...BASE, language: "en", minCancelHours: 0 });
    expect(prompt).toContain("Minimum notice to cancel: no policy (no minimum notice).");
    expect(prompt).not.toContain("My account");
    expect(prompt).not.toMatch(/24 hours/);
  });

  it("helpers: 1 hour is singular; unknown counts as no minimum", () => {
    expect(cancellationPolicyLines("es", null, 1)).toContain("1 hora antes");
    expect(lateCancellationLine("en", 1)).toContain("less than 1 hour away");
    expect(lateCancellationLine("es", undefined)).toContain("no pide un plazo mínimo");
    expect(cancellationPolicyLines("es", "x".repeat(2000), 0)).toHaveLength(
      cancellationPolicyLines("es", "x".repeat(1000), 0).length,
    );
  });
});
