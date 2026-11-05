import { TransformFnParams } from "class-transformer";

/**
 * Limits shared by the create and update bodies of a service.
 *
 * Without them a service could be saved with 0 or 7.5 minutes, a negative
 * price, a deposit of 500 %, or a currency nothing else in the app handles.
 */
export const SERVICE_LIMITS = {
  durationMin: 5,
  durationMax: 600,
  priceMax: 100_000,
  bufferMax: 240,
  /** Hours of notice an online booking needs: up to 30 days. */
  minAdvanceHoursMax: 720,
  /** Days ahead an online booking may be made: up to two years. */
  maxAdvanceDaysMax: 730,
} as const;

/** The only currency the app formats, invoices and charges. */
export const SERVICE_CURRENCIES = ["EUR"] as const;

/**
 * A number sent as text becomes that number. Prisma returns a Decimal
 * column as a string ("25.00"), so a panel that sends a service back as it
 * came was refused with a 400 until the price was retyped. Anything that is
 * not a non-empty string is left alone for the validators to judge: "" and
 * null are not turned into 0.
 */
export function numberFromText({ value }: TransformFnParams): unknown {
  if (typeof value === "string" && value.trim() !== "") return Number(value.trim());
  return value;
}

/** Surrounding spaces off, so "   " counts as empty. */
export function trimmed({ value }: TransformFnParams): unknown {
  return typeof value === "string" ? value.trim() : value;
}
