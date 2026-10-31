/**
 * The specialties the professional edit page offers, and how that page treats
 * the specialty a professional already has.
 *
 * `value` is what is stored in Professional.specialties (in English, as it
 * always was, so existing professionals keep theirs); `key` names the label
 * under `professionals.specialtyOptions` in messages/{es,en}.json.
 *
 * Professionals created by the onboarding wizard or the new-professional form
 * have no specialty, or a free-text one ("Estilista senior"). The edit page
 * used to require one from this list, so those professionals could not be
 * saved -- not even to change their schedule -- until one was picked, and
 * saving replaced whatever they had with that pick. Now the stored value is
 * shown as it is and only sent when the salon changes it.
 *
 * No React and no Next imports, so lib/professional-specialties.spec.ts can
 * run them.
 */
export const PROFESSIONAL_SPECIALTIES = [
  { value: "Hair Stylist", key: "hairStylist" },
  { value: "Nail Technician", key: "nailTechnician" },
  { value: "Makeup Artist", key: "makeupArtist" },
  { value: "Massage Therapist", key: "massageTherapist" },
  { value: "Esthetician", key: "esthetician" },
  { value: "Barber", key: "barber" },
  { value: "Beauty Consultant", key: "beautyConsultant" },
] as const;

/** The translation key for a stored specialty, or null for free text. */
export function specialtyLabelKey(value: string | null | undefined): string | null {
  const found = PROFESSIONAL_SPECIALTIES.find((s) => s.value === value);
  return found ? `professionals.specialtyOptions.${found.key}` : null;
}

/** The specialty the edit page shows for what is stored: the first one, or "". */
export function currentSpecialty(stored: unknown): string {
  if (!Array.isArray(stored)) return "";
  const first = stored.find((s) => typeof s === "string" && s.trim() !== "");
  return typeof first === "string" ? first.trim() : "";
}

/**
 * The options of the specialty select: the list, plus the professional's own
 * free-text specialty first when it is not one of them, so it is shown and
 * kept rather than silently replaced. `labelKey` null means "show the value
 * as it is".
 */
export function specialtyOptions(current: string): Array<{ value: string; labelKey: string | null }> {
  const options = PROFESSIONAL_SPECIALTIES.map((s) => ({
    value: s.value as string,
    labelKey: `professionals.specialtyOptions.${s.key}`,
  }));
  if (current && !specialtyLabelKey(current)) return [{ value: current, labelKey: null }, ...options];
  return options;
}

/**
 * Whether the edit page insists on a specialty: only when the professional
 * already has one, so it is not cleared by mistake. A professional without
 * one can be saved as they are.
 */
export function specialtyIsRequired(original: string): boolean {
  return original !== "";
}

/**
 * The `specialties` to send on save: nothing (keep what is stored, all of it)
 * unless the salon changed the specialty; then the new one, or none.
 */
export function specialtiesForSave(original: string, selected: string): string[] | undefined {
  if (selected === original) return undefined;
  return selected ? [selected] : [];
}
