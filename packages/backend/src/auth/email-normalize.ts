import { Transform } from "class-transformer";

/**
 * Accounts are found by email, and an email is the same address whatever
 * its case: "Maria@Gmail.com" (a phone capitalising the first letter) used
 * to be a different account from "maria@gmail.com", so the owner who signed
 * up with the first could not sign in with the second, and the lockout
 * counted her tries. Every form that names an account normalises it first.
 */
export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** DTO field decorator: trims and lower-cases a string email before validation. */
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === "string" ? normalizeEmail(value) : value));
}
