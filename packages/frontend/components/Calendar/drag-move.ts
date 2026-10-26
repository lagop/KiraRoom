/**
 * What dropping an appointment on the calendar means: where it goes, whether
 * this user may put it there, and what to say when the server refuses.
 * Pure, so it is tested without the browser (drag-move.spec.ts).
 */

/** Height of a 15-minute row in the time grid (TimeGrid: 96px per hour). */
export const PX_PER_QUARTER = 24;

export function minutesFromDrag(deltaY: number): number {
  return Math.round(deltaY / PX_PER_QUARTER) * 15;
}

/**
 * The professional column the block was dropped on: the drop target's data,
 * or the column id ("professional-column-<id>"); else the current one.
 */
export function droppedOnProfessional(
  over: { id?: unknown; data?: { current?: { professionalId?: string } | null } } | null | undefined,
  currentProfessionalId: string,
): string {
  const fromData = over?.data?.current?.professionalId;
  if (fromData) return fromData;
  const id = typeof over?.id === "string" ? over.id : "";
  if (id.startsWith("professional-column-")) return id.slice("professional-column-".length);
  return currentProfessionalId;
}

export type MovePlan =
  | { kind: "none" }
  | { kind: "refuse"; message: string }
  | { kind: "move"; professionalId: string; start: Date; end: Date };

export function planMove(input: {
  start: string;
  end: string;
  professionalId: string;
  newProfessionalId: string;
  minutesDelta: number;
  /** A professional moves their own appointments within their own column. */
  isStaff: boolean;
}): MovePlan {
  const changedColumn = input.newProfessionalId !== input.professionalId;
  if (!changedColumn && input.minutesDelta === 0) return { kind: "none" };
  if (changedColumn && input.isStaff) {
    return { kind: "refuse", message: "Solo puedes mover tus citas dentro de tu agenda." };
  }
  const start = new Date(new Date(input.start).getTime() + input.minutesDelta * 60_000);
  const end = new Date(new Date(input.end).getTime() + input.minutesDelta * 60_000);
  return { kind: "move", professionalId: input.newProfessionalId, start, end };
}

/** What the salon reads when a move fails: the server's reason when it gave one. */
export function moveErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message && !/^API Error|Failed to fetch|NetworkError/i.test(message)) return message;
  return "No se ha podido mover la cita. Inténtalo de nuevo.";
}
