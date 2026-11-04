/**
 * Datos del salón: the form's fields -> the PATCH /auth/tenant body.
 *
 * Blank optional fields used to go as undefined, which the server ignores:
 * a description, postal code or province could never be removed, and the
 * old text stayed on the public page and in its SEO data. They now go as
 * null, which clears them.
 */
export interface SalonIdentityFields {
  name: string;
  description: string;
  street: string;
  city: string;
  postalCode: string;
  state: string;
  phone: string;
  logo: string;
  /** The public page's cover photo; blank clears it. Left out when absent. */
  coverImage?: string;
  /**
   * The public page's links: the salon's own website, its WhatsApp number
   * ("Escríbenos por WhatsApp") and its own privacy policy (instead of the
   * generated one). Blank clears them; left out when absent.
   */
  website?: string;
  whatsapp?: string;
  privacyPolicyUrl?: string;
}

export function salonIdentityUpdate(f: SalonIdentityFields) {
  const orNull = (v: string) => v.trim() || null;
  return {
    name: f.name.trim(),
    description: orNull(f.description),
    street: f.street.trim(),
    city: f.city.trim(),
    postalCode: orNull(f.postalCode),
    state: orNull(f.state),
    phone: orNull(f.phone),
    logo: f.logo.trim(),
    ...(f.coverImage !== undefined ? { coverImage: orNull(f.coverImage) } : {}),
    ...(f.website !== undefined ? { website: orNull(f.website) } : {}),
    ...(f.whatsapp !== undefined ? { whatsapp: orNull(f.whatsapp) } : {}),
    ...(f.privacyPolicyUrl !== undefined ? { privacyPolicyUrl: orNull(f.privacyPolicyUrl) } : {}),
  };
}
