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

/** One service block of a multi-service visit, as the calendar holds it. */
export interface VisitBlock {
  id: string;
  serviceName?: string;
  start: string;
  end: string;
  isParallel?: boolean;
}

export type ServiceOnlyEffect =
  | { kind: "same" }
  | { kind: "wait"; minutes: number; before: string; after: string }
  | { kind: "two-places"; with: string };

/**
 * What moving only one service of a visit does to the client, shown before
 * the owner confirms: she would wait between two services (and how long), or
 * be in two at once (refused). Parallel services may overlap by design.
 */
export function serviceOnlyEffect(blocks: VisitBlock[], draggedId: string, minutesDelta: number): ServiceOnlyEffect {
  const shift = (iso: string) => new Date(new Date(iso).getTime() + minutesDelta * 60_000).getTime();
  const after = blocks.map((b) =>
    b.id === draggedId ? { ...b, s: shift(b.start), e: shift(b.end) } : { ...b, s: new Date(b.start).getTime(), e: new Date(b.end).getTime() },
  );
  const moved = after.find((b) => b.id === draggedId)!;
  if (!moved.isParallel) {
    const clash = after.find((b) => b.id !== draggedId && !b.isParallel && b.s < moved.e && moved.s < b.e);
    if (clash) return { kind: "two-places", with: clash.serviceName ?? "otro servicio" };
  }
  const gaps = (list: typeof after) => {
    const serial = list.filter((b) => !b.isParallel).sort((x, y) => x.s - y.s);
    let worst = { minutes: 0, before: "", after: "" };
    for (let i = 1; i < serial.length; i++) {
      const gap = Math.round((serial[i].s - serial[i - 1].e) / 60_000);
      if (gap > worst.minutes) worst = { minutes: gap, before: serial[i - 1].serviceName ?? "", after: serial[i].serviceName ?? "" };
    }
    return worst;
  };
  const was = gaps(blocks.map((b) => ({ ...b, s: new Date(b.start).getTime(), e: new Date(b.end).getTime() })));
  const now = gaps(after);
  if (now.minutes > was.minutes) return { kind: "wait", ...now };
  return { kind: "same" };
}

/** The sentence under "Mover solo este servicio". */
export function serviceOnlyText(effect: ServiceOnlyEffect): string {
  switch (effect.kind) {
    case "two-places":
      return `No se puede: la clienta estaría a la vez en ${effect.with}.`;
    case "wait":
      return `La clienta esperará ${effect.minutes} min entre ${effect.before || "un servicio"} y ${effect.after || "el siguiente"}.`;
    default:
      return "La clienta no esperará más que antes.";
  }
}
