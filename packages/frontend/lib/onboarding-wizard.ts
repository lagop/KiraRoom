/**
 * The onboarding wizard's week, and when it is sent.
 *
 * Invited owners used to land on /dashboard/onboarding (now "Más ajustes"). Its
 * editor used to start at Monday-Friday 09:00-19:00 whatever the salon had
 * saved, and "Guardar y empezar" always sent it: the salon was left closed
 * on Saturdays and after 19:00, and online booking stopped offering those
 * hours. Now the editor starts from the saved week, and the week is sent
 * only when the owner changed it, or when the salon has none yet.
 */
import { WEEK_DAYS, type WeeklySchedule } from "./weekly-schedule";

export interface WizardHoursEntry {
  day: string;
  openTime: string;
  closeTime: string;
}

export function wizardHoursToSend(
  week: WizardHoursEntry[],
  touched: boolean,
  hasSavedHours: boolean,
): WizardHoursEntry[] | undefined {
  if (hasSavedHours && !touched) return undefined;
  // A week with no open day stores nothing (the server skips it), as before.
  return week.length > 0 ? week : undefined;
}

/** Just what the checklist and the host read from GET /onboarding/state. */
export interface OnboardingStateLike {
  currentStep: number;
  checklistDismissed: boolean;
  finishedAt: string | null;
  steps: Record<string, { status: string } | undefined>;
  defs: Array<{ key: string; group: string }>;
}

/** The optional checklist steps still to do (neither done nor skipped). */
export function pendingChecklistSteps(state: OnboardingStateLike): number {
  return state.defs.filter((d) => {
    if (d.group !== "checklist_optional") return false;
    const s = state.steps[d.key];
    return !s || s.status === "pending";
  }).length;
}

/**
 * Nothing left to show: the required steps are done and the checklist was
 * closed or has nothing pending. The panel then stops asking the server
 * (I13): it used to every 30 s, in every tab, for ever, and each request ran
 * every detector and wrote to the database.
 */
export function onboardingSettled(state: OnboardingStateLike | null | undefined): boolean {
  if (!state) return false;
  if (!state.finishedAt) return false;
  return state.checklistDismissed || pendingChecklistSteps(state) === 0;
}

/**
 * Whether the checklist starts open. Only on the dashboard home, and not
 * once the owner has folded it away (remembered in this browser; I26).
 */
export function checklistStartsOpen(pathname: string | null, foldedBefore: boolean): boolean {
  return pathname === "/dashboard" && !foldedBefore;
}

/** "Restaurar checklist" only when restoring it would show something. */
export function showChecklistRestore(state: OnboardingStateLike): boolean {
  return state.checklistDismissed && pendingChecklistSteps(state) > 0;
}

/**
 * Whether the full-screen 3-step overlay is shown. Not while the salon is
 * read-only: every "Guardar y continuar" would fail and the overlay hid the
 * way to Facturación, so the salon was locked in; the read-only banner with
 * its Facturación link shows instead. Not while KiraRoom staff impersonate
 * the salon either: it covered the "Exit impersonation" banner (O3).
 */
export function showLinearOverlay(args: {
  finishedAt: string | null;
  currentStep: number;
  linearSteps: number;
  readOnly: boolean;
  impersonating: boolean;
}): boolean {
  if (args.readOnly || args.impersonating) return false;
  return !args.finishedAt && args.currentStep < args.linearSteps;
}

/** "YYYY-MM-DD" today on the salon's clock: the test booking's earliest day (O12). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** What is wrong with a custom service before it is sent, in Spanish; null when fine (O14). */
export function customServiceProblem(s: { name: string; durationMinutes: number; price: number }): string | null {
  if (!s.name.trim()) return null; // an empty row is left out, not refused
  if (!Number.isInteger(s.durationMinutes) || s.durationMinutes < 5) {
    return `«${s.name.trim()}»: la duración tiene que ser de al menos 5 minutos.`;
  }
  if (s.durationMinutes > 1440) return `«${s.name.trim()}»: la duración no puede pasar de 24 horas.`;
  if (!Number.isFinite(s.price) || s.price < 0) return `«${s.name.trim()}»: el precio no puede ser negativo.`;
  return null;
}

/**
 * The wizard's closing screen, from what the server says was saved (O4): it
 * said "¡Tu salón está listo! Ya puedes empezar a recibir reservas" even when
 * nothing had been created, and hid why the test booking was not.
 */
export function wizardOutcome(
  res: { saved?: { services: number; hours: boolean; appointment: boolean }; skipped?: { appointment: string | null } },
  ready: { hasServices: boolean; hasStaff: boolean; hasWorkingHours: boolean },
): { title: string; lines: string[]; warning: string | null; readyForBookings: boolean } {
  const saved = res.saved ?? { services: 0, hours: false, appointment: false };
  const lines: string[] = [];
  if (saved.services === 1) lines.push("Se ha creado 1 servicio.");
  else if (saved.services > 1) lines.push(`Se han creado ${saved.services} servicios.`);
  if (saved.hours) lines.push("Se ha guardado el horario de apertura.");
  if (saved.appointment) lines.push("Se ha creado la cita de prueba: la verás en la agenda con la etiqueta «Prueba» y se borra sola mañana si no la cobras ni la facturas.");
  let warning: string | null = null;
  if (res.skipped?.appointment === "no_staff") {
    warning =
      "La cita de prueba no se ha creado: la cuenta aún no tiene ningún profesional activo. Añade uno en Equipo y vuelve aquí.";
  } else if (res.skipped?.appointment === "no_service") {
    warning = "La cita de prueba no se ha creado: el servicio elegido no está entre los servicios activos del salón.";
  }
  const readyForBookings =
    (ready.hasServices || saved.services > 0) && ready.hasStaff && (ready.hasWorkingHours || saved.hours);
  const nothing = lines.length === 0;
  return {
    title: nothing ? "No se ha guardado nada nuevo" : readyForBookings ? "¡Tu salón está listo para recibir reservas!" : "Configuración guardada",
    lines,
    warning,
    readyForBookings,
  };
}

/**
 * D10: the salon's opening hours proposed in the overlay's last step: the
 * first professional's week, or Monday to Saturday 09:00 to 20:00 when that
 * week has no working day. A copy: editing one does not change the other.
 */
export function salonHoursFromProfessional(pro: WeeklySchedule | null | undefined): WeeklySchedule {
  const works = pro && WEEK_DAYS.some(({ key }) => pro[key]?.works && pro[key].shifts.length > 0);
  const week = {} as WeeklySchedule;
  for (const { key } of WEEK_DAYS) {
    if (works && pro) {
      week[key] = { works: pro[key].works, shifts: pro[key].shifts.map((s) => ({ ...s })) };
    } else {
      const open = key !== "sunday";
      week[key] = { works: open, shifts: open ? [{ start: "09:00", end: "20:00" }] : [] };
    }
  }
  return week;
}
