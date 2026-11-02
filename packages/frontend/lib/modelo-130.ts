import { euros } from "./modelo-420";
import type { Modelo130Income } from "./api";

/**
 * The "Ingresos para tu modelo 130" card: an autónomo's income from her
 * invoices (base imponible, tax not included, rectificativas subtracted),
 * per quarter and from 1 January, which is what the 130 asks for. KiraRoom
 * prepares no 130: the expenses and the return are the gestor's.
 */
export interface Modelo130Row {
  quarter: string;
  invoiced: string;
  rectified: string;
  income: string;
  cumulative: string;
}

export function modelo130Rows(income: Pick<Modelo130Income, "quarters">): Modelo130Row[] {
  return income.quarters.map((q) => ({
    quarter: `${q.quarter}T`,
    invoiced: euros(q.invoicedCents),
    rectified: q.rectifiedCents ? euros(q.rectifiedCents) : "—",
    income: euros(q.incomeCents),
    cumulative: euros(q.cumulativeCents),
  }));
}

/** When the 130 of a quarter is due (AEAT: days 1-20 of the next month; Q4 by 30 January). */
export function modelo130Deadline(year: number, quarter: number): string {
  if (quarter === 4) return `del 1 al 30 de enero de ${year + 1}`;
  const month = ["abril", "julio", "octubre"][quarter - 1];
  return `del 1 al 20 de ${month} de ${year}`;
}
