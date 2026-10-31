/**
 * Addresses KiraRoom makes up for records that have no real email: clients
 * created without one (`wizard-…@placeholder.local`, onboarding) and users
 * anonymised under GDPR (`…@deleted.local`). `.local`, `.localhost` and
 * `.invalid` are reserved names that never deliver, so any address on them
 * counts too. Nothing should be emailed to these.
 */
const PLACEHOLDER_DOMAIN = /@(?:[^@\s]+\.)?(?:local|localhost|invalid)$/i;

/** A stand-in address for a client created without one. */
export function placeholderEmail(localPart: string): string {
  return `${localPart}@placeholder.local`;
}

/** True for an address KiraRoom generated as a stand-in for a missing one. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && PLACEHOLDER_DOMAIN.test(email.trim());
}

/** The address when there is a real one; null when missing or a placeholder. */
export function realEmail(email: string | null | undefined): string | null {
  const value = email?.trim();
  return value && !isPlaceholderEmail(value) ? value : null;
}
