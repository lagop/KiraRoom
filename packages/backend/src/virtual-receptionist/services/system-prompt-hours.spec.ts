import { ConfigService } from "@nestjs/config";
import { LLMService } from "./llm.service";

/**
 * The opening hours the receptionist is told about.
 *
 * Two separate bugs met here, and between them the assistant had never known
 * any salon's hours:
 *
 * 1. `formatWorkingHours` looked the days up by their SPANISH names while the
 *    data is keyed in English. Nothing ever matched, the function returned an
 *    empty string, and the fallback rendered "Not available" — for every
 *    Spanish salon, which is all of them.
 * 2. The separator was the two-character sequence backslash-n rather than a
 *    newline, so the English path put the whole week on one line with visible
 *    backslashes.
 *
 * And the data itself was hardcoded: Monday–Friday 09:00–18:00 plus Saturday
 * 09:00–14:00 for every tenant, contradicting the schedules
 * `check_availability` reads. See salon-week.spec.ts for the derivation.
 */

function promptFor(context: Record<string, unknown>): string {
  const configService = { get: (): undefined => undefined } as unknown as ConfigService;
  const stub = {} as any;
  const service = new LLMService(stub, configService, stub, stub, stub, stub, stub);
  return (service as any).buildSystemPrompt(context);
}

const WEEK = {
  monday: { start: "09:00", end: "18:00" },
  tuesday: { start: "09:00", end: "19:00" },
  friday: { start: "10:00", end: "20:00" },
};

const BASE = {
  id: "tenant-1",
  name: "Salon Prueba",
  assistantName: "Kira",
  timezone: "Atlantic/Canary",
  minCancelHours: 24,
  faqs: [],
};

describe("the Spanish prompt carries the real hours", () => {
  it("no longer says the hours are not available", () => {
    // The bug: this section was "Not available" for every Spanish salon.
    // Scoped to the hours section on purpose — an absent address or phone
    // legitimately renders "Not available" elsewhere in the prompt.
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });
    const marker = "Horarios de atención:**";
    const section = prompt.slice(prompt.indexOf(marker) + marker.length, prompt.indexOf(marker) + marker.length + 200);

    expect(prompt).toContain(marker);
    expect(section).not.toContain("Not available");
  });

  it("names the days in Spanish with their own windows", () => {
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("- lunes: 09:00–18:00");
    expect(prompt).toContain("- martes: 09:00–19:00");
    expect(prompt).toContain("- viernes: 10:00–20:00");
  });

  it("marks the days the salon does not open", () => {
    // Listing them lets the receptionist say "los domingos cerramos" instead
    // of going quiet, and it is what agrees with check_availability.
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("- sábado: cerrado");
    expect(prompt).toContain("- domingo: cerrado");
    expect(prompt).toContain("- miércoles: cerrado");
  });

  it("puts each day on its own line", () => {
    // The bug: a literal backslash-n joined them into one line.
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("- lunes: 09:00–18:00\n- martes:");
    expect(prompt).not.toContain("\\n- martes");
  });

  it("lists the week Monday first", () => {
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });
    const order = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
      .map((day) => prompt.indexOf(`- ${day}:`));

    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the English prompt carries the real hours too", () => {
  it("names the days in English on separate lines", () => {
    const prompt = promptFor({ ...BASE, language: "en", workingHours: WEEK });

    expect(prompt).toContain("- Monday: 09:00–18:00");
    expect(prompt).toContain("- Tuesday: 09:00–19:00");
    expect(prompt).toContain("- Monday: 09:00–18:00\n- Tuesday:");
    expect(prompt).not.toContain("\\n- Tuesday");
  });

  it("says closed rather than closed–closed", () => {
    // The hardcoded Sunday was { start: 'closed', end: 'closed' }, which
    // rendered as "Sunday: closed–closed".
    const prompt = promptFor({ ...BASE, language: "en", workingHours: WEEK });

    expect(prompt).toContain("- Sunday: closed");
    expect(prompt).not.toContain("closed–closed");
  });
});

describe("an unknown week is admitted, not invented", () => {
  it("falls back to saying the hours are unavailable when there is no week", () => {
    // A salon whose professionals have no schedule recorded. Saying so is
    // correct; making up a Monday-to-Friday default is how this started.
    const prompt = promptFor({ ...BASE, language: "es", workingHours: {} });

    expect(prompt).toContain("Not available");
    expect(prompt).not.toContain("- lunes:");
  });

  it("does not crash when workingHours is missing entirely", () => {
    expect(() => promptFor({ ...BASE, language: "es" })).not.toThrow();
  });
});

describe("the booking flow is actually in the prompt", () => {
  it("includes the staged booking instructions", () => {
    // getBookingFlowPrompt was imported and never called, so the model had to
    // improvise the one job this assistant exists to do.
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("ETAPA: CONFIRMATION");
    expect(prompt).toContain("ETAPA: TIME");
  });

  it("includes the rules drawn from real failures", () => {
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("ERRORES CONCRETOS QUE DEBES EVITAR");
    expect(prompt).toContain("check_availability");
  });

  it("includes the cancellation handling instructions", () => {
    const prompt = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(prompt).toContain("Cómo manejar cancelaciones, cambios y retrasos");
  });

  it("stays byte-identical across calls, so the cache prefix holds", () => {
    const a = promptFor({ ...BASE, language: "es", workingHours: WEEK });
    const b = promptFor({ ...BASE, language: "es", workingHours: WEEK });

    expect(b).toBe(a);
    // Nothing volatile crept in with the new blocks.
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("the booking flow ends honestly", () => {
  // No tool creates an appointment. The flow used to end with "Confirma que
  // la cita ha sido registrada exitosamente" and a reference number, pushing
  // the model to tell a client they had an appointment that did not exist.
  const withSlug = { ...BASE, slug: "salon-prueba", workingHours: WEEK };

  it("gives the client the salon's booking page", () => {
    const prompt = promptFor({ ...withSlug, language: "es" });
    expect(prompt).toMatch(/Reserva online:\*\* https?:\/\/\S+\/sites\/salon-prueba/);
  });

  it("never tells the model to confirm a registration", () => {
    for (const language of ["es", "en"]) {
      const prompt = promptFor({ ...withSlug, language });
      expect(prompt).not.toMatch(/ha sido registrada exitosamente|has been successfully registered/);
      expect(prompt).not.toContain("{{booking_reference}}");
      expect(prompt).not.toMatch(/Confirmas esta reserva|Do you confirm this booking/);
    }
  });

  it("proposes, then books, and confirms only on created: true", () => {
    for (const language of ["es", "en"]) {
      const prompt = promptFor({ ...withSlug, language });
      expect(prompt).toContain("propose_appointment");
      expect(prompt).toContain("create_appointment");
      expect(prompt).toContain("created: true");
      expect(prompt).not.toContain("clientConfirmed");
    }
  });

  it("asks for the phone, which the booking needs, and the email only as an option", () => {
    expect(promptFor({ ...withSlug, language: "es" })).toMatch(/\*\*teléfono\*\* \(obligatorio/);
    expect(promptFor({ ...withSlug, language: "es" })).toMatch(/El email es opcional/);
    expect(promptFor({ ...withSlug, language: "en" })).toMatch(/\*\*phone\*\* \(required/);
    expect(promptFor({ ...withSlug, language: "en" })).toMatch(/The email is optional/);
  });
});
