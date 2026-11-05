/**
 * Editing the services of a multi-service visit from the appointment form.
 * Pure: decides which rows stay, which are new and which go; the service
 * that applies it is AppointmentsService.update. Tested in visit-edit.spec.ts.
 *
 * Every edit used to delete all the visit's rows and create them again, so
 * a save (even of a note: the form always resends the services) lost each
 * service's times, status and notes -- a service already done became
 * pending again.
 *
 * Rows are matched by service, in order (the same professional first): a
 * row whose service is still in the list stays as it is, with its new
 * position, mode and professional; a service not in the visit yet is added;
 * a row whose service is gone is removed.
 */

export interface ExistingRow {
  id: string;
  serviceId: string;
  professionalId: string | null;
  isParallel: boolean;
  order?: number | null;
  status?: string | null;
}

export interface IncomingRow {
  serviceId: string;
  professionalId?: string | null;
  isParallel?: boolean;
}

export interface KeptRow<R extends ExistingRow = ExistingRow> {
  row: R;
  order: number;
  professionalId: string | null;
  isParallel: boolean;
  /**
   * Its place among the services that stay, or its mode, changed: its
   * stored times no longer mean anything and it follows the visit's layout.
   */
  retime: boolean;
  /** Anything to write. */
  changed: boolean;
}

export interface RowEdit<R extends ExistingRow = ExistingRow> {
  keep: KeptRow<R>[];
  add: Array<{ order: number; serviceId: string; professionalId: string | null; isParallel: boolean }>;
  remove: R[];
}

/** `existing` in the visit's current order; `incoming` in the order the form sends. */
export function planRowEdit<R extends ExistingRow>(existing: R[], incoming: IncomingRow[]): RowEdit<R> {
  const used = new Set<string>();
  const matched: Array<R | null> = incoming.map((item) => {
    const professionalId = item.professionalId || null;
    const candidates = existing.filter((r) => !used.has(r.id) && r.serviceId === item.serviceId);
    const pick = candidates.find((r) => r.professionalId === professionalId) ?? candidates[0] ?? null;
    if (pick) used.add(pick.id);
    return pick;
  });

  // Where each staying row was, among the rows that stay, and where it is now.
  const staying = existing.filter((r) => used.has(r.id));
  const keptInNewOrder = matched.filter((r): r is R => r !== null);

  const keep: KeptRow<R>[] = [];
  const add: RowEdit<R>["add"] = [];
  incoming.forEach((item, order) => {
    const professionalId = item.professionalId || null;
    const isParallel = !!item.isParallel;
    const row = matched[order];
    if (!row) {
      add.push({ order, serviceId: item.serviceId, professionalId, isParallel });
      return;
    }
    const retime = isParallel !== !!row.isParallel || staying.indexOf(row) !== keptInNewOrder.indexOf(row);
    keep.push({
      row,
      order,
      professionalId,
      isParallel,
      retime,
      changed: retime || professionalId !== (row.professionalId ?? null) || (row.order ?? order) !== order,
    });
  });

  return { keep, add, remove: existing.filter((r) => !used.has(r.id)) };
}

/** Whether the edit changes anything at all. */
export function editChangesRows(edit: RowEdit<any>): boolean {
  return edit.add.length > 0 || edit.remove.length > 0 || edit.keep.some((k) => k.changed);
}
