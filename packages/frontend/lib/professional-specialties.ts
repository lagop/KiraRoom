/**
 * The specialties the professional edit page offers. `value` is what is
 * stored in Professional.specialties (in English, as it always was, so
 * existing professionals keep theirs); `key` names the label under
 * `professionals.specialtyOptions` in messages/{es,en}.json.
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
