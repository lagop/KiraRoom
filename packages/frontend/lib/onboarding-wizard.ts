/**
 * The onboarding wizard's week, and when it is sent.
 *
 * Every owner invited to KiraRoom lands on /dashboard/onboarding. Its
 * editor used to start at Monday-Friday 09:00-19:00 whatever the salon had
 * saved, and "Guardar y empezar" always sent it: the salon was left closed
 * on Saturdays and after 19:00, and online booking stopped offering those
 * hours. Now the editor starts from the saved week, and the week is sent
 * only when the owner changed it, or when the salon has none yet.
 */
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
