import { claimsBooking, looksLikeSummary } from "./booking-claims";

describe("claimsBooking", () => {
  it.each([
    "¡Excelente! Tu cita está confirmada.",
    "¡Excelente, Laura! Tu cita está **confirmada**. ✨",
    "Perfecto, he reservado tu cita para el jueves.",
    "Listo: cita confirmada para el 1 de octubre.",
    "¡Te esperamos el jueves a las 10:30!",
    "Your appointment is confirmed for Thursday.",
    "You're all set for Thursday at 10:30.",
    "Excelente, entonces tienes la cita para el viernes a las 16:30 ✅",
  ])("reads %p as a booking claim", (text) => expect(claimsBooking(text)).toBe(true));

  it.each([
    "Todavía no está reservada. ¿Te propongo el resumen?",
    "Tu cita todavía no está confirmada: responde sí al resumen.",
    "📋 Resumen de tu cita: ... ¿Es correcto? (Sí / No)",
    "Tenemos huecos a las 10:00 y 10:30.",
    "Your appointment is not booked yet.",
  ])("does not read %p as a booking claim", (text) => expect(claimsBooking(text)).toBe(false));
});

describe("looksLikeSummary", () => {
  it("recognises the booking summary", () => {
    expect(looksLikeSummary("📋 **Resumen de tu cita:** ... ¿Es correcto? (Sí / No)")).toBe(true);
    expect(looksLikeSummary("📋 *Summary of your appointment:* ... Is this correct? (Yes / No)")).toBe(true);
  });
  it("ignores ordinary replies", () => {
    expect(looksLikeSummary("Tenemos huecos a las 16:00 y 16:30. ¿Cuál prefieres?")).toBe(false);
  });
});
