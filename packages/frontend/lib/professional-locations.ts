/**
 * The team form's locations (multi-local): which of the salon's locations a
 * professional works at, and which one is their main one. Their weekly hours
 * are the same at all of them; the agenda never books them twice at once.
 *
 * The form sends the list only when it was changed, so a salon without the
 * multi-location plan (the picker hidden) never sends one.
 */

export interface LocationChoice {
  ids: string[];
  /** One of `ids`, or null when there is none. */
  primary: string | null;
}

export const NO_LOCATIONS: LocationChoice = { ids: [], primary: null };

/** What the professional has now, from GET /admin/professionals/:id. */
export function locationsOf(professional: {
  locations?: Array<{ locationId: string; isPrimary?: boolean }> | null;
}): LocationChoice {
  const links = professional.locations ?? [];
  const ids = links.map((l) => l.locationId);
  const primary = links.find((l) => l.isPrimary)?.locationId ?? ids[0] ?? null;
  return { ids, primary };
}

/**
 * Ticks or unticks a location. The first one ticked becomes the main one;
 * unticking the main one passes it to the first left.
 */
export function toggleLocation(choice: LocationChoice, id: string): LocationChoice {
  if (choice.ids.includes(id)) {
    const ids = choice.ids.filter((x) => x !== id);
    return { ids, primary: choice.primary === id ? ids[0] ?? null : choice.primary };
  }
  const ids = [...choice.ids, id];
  return { ids, primary: choice.primary ?? id };
}

/** Makes a ticked location the main one; an unticked one is ticked too. */
export function makePrimary(choice: LocationChoice, id: string): LocationChoice {
  const ids = choice.ids.includes(id) ? choice.ids : [...choice.ids, id];
  return { ids, primary: id };
}

/** The body fields: nothing when the form did not touch the locations. */
export function locationsPayload(
  choice: LocationChoice,
  touched: boolean,
): { locationIds?: string[]; primaryLocationId?: string | null } {
  if (!touched) return {};
  return { locationIds: choice.ids, primaryLocationId: choice.ids.length ? choice.primary : null };
}

/** The locations a professional can be assigned to: the open ones. */
export function assignableLocations<T extends { isActive?: boolean }>(locations: T[] | null | undefined): T[] {
  return (locations ?? []).filter((l) => l.isActive !== false);
}
