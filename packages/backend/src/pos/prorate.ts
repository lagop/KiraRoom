/**
 * Shares an amount of cents over lines in proportion to a weight, each line
 * taking at most its cap, in whole cents that add up to the amount exactly.
 *
 * Used for the loyalty reward on an invoice (pos.service.ts: by each line's
 * tax base, at most the line's total) and for a refund over the lines of a
 * till sale (payments/refund-lines.ts: by what is left of each line).
 *
 * The rounding: each line gets the whole cents of its exact share; the cents
 * left over by the rounding go to the line with the largest weight (then the
 * next largest, when that one is full). A line whose exact share reaches its
 * cap takes the cap and the rest is shared again over the others, so no line
 * goes past what it is worth (mixed tax rates: a 0 % line has a larger base
 * for the same money and would otherwise be taken below zero).
 *
 * An amount over the sum of the caps is shared up to the caps: the rest is
 * not placed (the callers never ask for more than the lines are worth).
 */
export interface ProrateItem {
  weight: number;
  cap: number;
}

export function prorateCapped(totalCents: number, items: ProrateItem[]): number[] {
  const shares = items.map(() => 0);
  const caps = items.map((i) => Math.max(0, Math.floor(i.cap)));
  const capSum = caps.reduce((s, c) => s + c, 0);
  let remaining = Math.min(Math.max(0, Math.round(totalCents)), capSum);
  if (remaining === 0) return shares;

  let active = items.map((_, i) => i).filter((i) => items[i].weight > 0 && caps[i] > 0);
  // No line has a weight: share by the caps instead.
  const weightOf = active.length > 0 ? (i: number) => items[i].weight : (i: number) => caps[i];
  if (active.length === 0) active = items.map((_, i) => i).filter((i) => caps[i] > 0);

  // Lines whose exact share reaches their cap take the cap; the rest is shared again.
  let exact = new Map<number, number>();
  for (;;) {
    const weightSum = active.reduce((s, i) => s + weightOf(i), 0);
    if (weightSum <= 0 || remaining <= 0) {
      exact = new Map();
      break;
    }
    exact = new Map(active.map((i) => [i, (remaining * weightOf(i)) / weightSum]));
    const full = active.filter((i) => (exact.get(i) as number) >= caps[i]);
    if (full.length === 0) break;
    for (const i of full) {
      shares[i] = caps[i];
      remaining -= caps[i];
    }
    active = active.filter((i) => !full.includes(i));
  }

  for (const [i, x] of exact) shares[i] = Math.floor(x);
  let left = remaining - [...exact.keys()].reduce((s, i) => s + shares[i], 0);
  // The rounding's cents: on the largest line, then the next.
  const byWeight = [...exact.keys()].sort((a, b) => weightOf(b) - weightOf(a) || a - b);
  for (const i of byWeight) {
    if (left <= 0) break;
    const take = Math.min(left, caps[i] - shares[i]);
    shares[i] += take;
    left -= take;
  }
  return shares;
}
