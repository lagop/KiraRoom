import { professionalImageUrl } from "./public-images";

/**
 * How a professional appears to anyone outside the salon: its public page,
 * its widget, schema.org data and GET /professionals without a session.
 *
 * Each professional has "Mostrar en la web" (Professional.webNameDisplay):
 *   full     "Ana García"
 *   initial  "Ana G."           (the default for new professionals)
 *   hidden   not named at all: still bookable, as "Profesional" ("Profesional
 *            2" when several are hidden), with nothing else about her, and left
 *            out of the team list and the schema.org data (listed: false).
 * and "Mostrar foto" (webShowPhoto): her photo and portfolio pictures.
 * Rows read without these columns (older callers, test doubles) keep what
 * the page always showed: full name and photo.
 *
 * Images come out as URLs (public-images.ts), never as stored data: URLs.
 */
export type WebNameDisplay = "full" | "initial" | "hidden";

export interface ProfessionalVisibility {
  webNameDisplay?: WebNameDisplay | string | null;
  webShowPhoto?: boolean | null;
}

export interface PublicProfessionalRow extends ProfessionalVisibility {
  id: string;
  firstName: string;
  lastName: string;
  profileImage?: string | null;
  bio?: string | null;
  position?: string | null;
  specialties?: unknown;
  portfolioImages?: unknown;
  yearsExperience?: number | null;
  languages?: unknown;
  certifications?: unknown;
}

/** The name shown for a professional who is shown by name. */
export function webName(firstName: string, lastName: string, display: WebNameDisplay): { firstName: string; lastName: string } {
  const first = (firstName ?? "").trim();
  if (display === "initial") {
    const initial = (lastName ?? "").trim().charAt(0).toUpperCase();
    return { firstName: first, lastName: initial ? `${initial}.` : "" };
  }
  return { firstName: first, lastName: (lastName ?? "").trim() };
}

export function displayOf(row: ProfessionalVisibility): WebNameDisplay {
  const d = row.webNameDisplay;
  return d === "initial" || d === "hidden" ? d : "full";
}

/** Whether her photo and portfolio may be shown (hidden: never). */
export function showsPhoto(row: ProfessionalVisibility): boolean {
  if (displayOf(row) === "hidden") return false;
  return row.webShowPhoto !== false;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The rows as anyone may see them, in the same order. Every field of the
 * input not handled here is kept (services, locations...); the visibility
 * columns themselves are dropped.
 */
export function publicProfessionals<T extends PublicProfessionalRow>(
  rows: T[],
): Array<Omit<T, "webNameDisplay" | "webShowPhoto"> & { listed: boolean }> {
  const hiddenCount = rows.filter((r) => displayOf(r) === "hidden").length;
  let hiddenSeen = 0;
  return rows.map((row) => {
    const { webNameDisplay: _d, webShowPhoto: _p, ...rest } = row;
    const display = displayOf(row);
    if (display === "hidden") {
      hiddenSeen += 1;
      return {
        ...rest,
        firstName: hiddenCount > 1 ? `Profesional ${hiddenSeen}` : "Profesional",
        lastName: "",
        ...("profileImage" in row ? { profileImage: null } : {}),
        ...("bio" in row ? { bio: null } : {}),
        ...("position" in row ? { position: null } : {}),
        ...("specialties" in row ? { specialties: [] } : {}),
        ...("portfolioImages" in row ? { portfolioImages: [] } : {}),
        ...("yearsExperience" in row ? { yearsExperience: null } : {}),
        ...("languages" in row ? { languages: [] } : {}),
        ...("certifications" in row ? { certifications: [] } : {}),
        listed: false,
      } as any;
    }
    const photo = showsPhoto(row);
    return {
      ...rest,
      ...webName(row.firstName, row.lastName, display),
      ...("profileImage" in row
        ? { profileImage: photo ? professionalImageUrl(row.id, "photo", row.profileImage) : null }
        : {}),
      ...("portfolioImages" in row
        ? {
            portfolioImages: photo
              ? strings(row.portfolioImages)
                  .map((img, i) => professionalImageUrl(row.id, `portfolio-${i}`, img))
                  .filter((u): u is string => !!u)
              : [],
          }
        : {}),
      listed: true,
    } as any;
  });
}

/**
 * The name one row shows to the public, on its own: "Ana", "Ana G." or
 * "Profesional" when hidden. For a row met alone (a booking's professional);
 * lists use publicProfessionalNames so hidden ones are numbered like the page.
 */
export function publicNameOf(row: ProfessionalVisibility & { firstName: string; lastName: string }): {
  firstName: string;
  lastName: string;
} {
  const display = displayOf(row);
  if (display === "hidden") return { firstName: "Profesional", lastName: "" };
  return webName(row.firstName, row.lastName, display);
}

export interface PublicProfessionalName {
  firstName: string;
  lastName: string;
  /** "Mostrar en la web: oculta": nothing else about her may be said either. */
  hidden: boolean;
}

/**
 * Every active professional of a salon as the public sees her, keyed by id,
 * in the order and numbering of the salon's page ("Profesional 1", "2"...).
 * The receptionist, its prompt and its tools name people only through this
 * (audit 2026-11-06): the real name of someone hidden from the web never
 * reaches a chat.
 */
export async function publicProfessionalNames(
  prisma: { professional: { findMany: (args: any) => Promise<any[]> } },
  tenantId: string,
): Promise<Map<string, PublicProfessionalName>> {
  const rows = await prisma.professional.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, firstName: true, lastName: true, webNameDisplay: true, webShowPhoto: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  const shown = publicProfessionals(rows as PublicProfessionalRow[]);
  return new Map(
    shown.map((p, i) => [
      (rows[i] as { id: string }).id,
      { firstName: p.firstName, lastName: p.lastName, hidden: displayOf(rows[i]) === "hidden" },
    ]),
  );
}

/** "Ana García" / "Ana G." / "Profesional 2": the text a chat may use for her. */
export const publicFullName = (n: { firstName: string; lastName: string }): string =>
  `${n.firstName} ${n.lastName}`.trim();
