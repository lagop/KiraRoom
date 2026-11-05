/**
 * The plan a salon picked on the website before signing up (B12): the
 * marketing site's plan cards link to /signup?plan=<id>, and the signup
 * used to ignore it. It is kept in this browser and the billing page
 * highlights that card until the salon pays for a plan. A hint only: the
 * trial is Pro whatever was picked, and nothing is charged from it.
 */
import { PLAN_IDS, type PlanId } from "../src/lib/plans";

export const DESIRED_PLAN_KEY = "kira.desiredPlan";

/** The plan in a query string ("?plan=pro"), or null for none or an unknown one. */
export function desiredPlanFromSearch(search: string | null | undefined): PlanId | null {
  if (!search) return null;
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get("plan");
  } catch {
    return null;
  }
  const plan = (value ?? "").trim().toLowerCase();
  return (PLAN_IDS as readonly string[]).includes(plan) ? (plan as PlanId) : null;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** On the signup page: keep the plan of the link, if there is one. */
export function rememberDesiredPlan(search: string | null | undefined, store: Storage | null = storage()): void {
  const plan = desiredPlanFromSearch(search);
  if (!plan || !store) return;
  try {
    store.setItem(DESIRED_PLAN_KEY, plan);
  } catch {
    // Private mode or storage full: the hint is lost, nothing else.
  }
}

export function readDesiredPlan(store: Storage | null = storage()): PlanId | null {
  if (!store) return null;
  try {
    const plan = store.getItem(DESIRED_PLAN_KEY);
    return plan && (PLAN_IDS as readonly string[]).includes(plan) ? (plan as PlanId) : null;
  } catch {
    return null;
  }
}

export function forgetDesiredPlan(store: Storage | null = storage()): void {
  try {
    store?.removeItem(DESIRED_PLAN_KEY);
  } catch {
    // ignore
  }
}
