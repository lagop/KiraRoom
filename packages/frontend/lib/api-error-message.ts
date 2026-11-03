/**
 * The message the panel shows for a failed API request.
 *
 * Most refusals carry the server's own Spanish message. A route that a role
 * may not call answers with the framework's English default instead
 * ("Forbidden resource", from the roles guard), and pages showed it as it
 * came: a professional who opened a management page read "Forbidden
 * resource". Those defaults are said in Spanish here; any other message
 * the server wrote is kept.
 */

export const FORBIDDEN_MESSAGE = "No tienes permiso para hacer esto. Si lo necesitas, pídeselo a la dirección del salón.";

/** The API's default English refusals: NestJS's 403 and the roles guard's own. */
const DEFAULT_FORBIDDEN = new Set(["Forbidden resource", "Forbidden", "This route is not open to your account"]);

/**
 * `raw` is the body's `message` (a string, or a list from a validation
 * failure); `fallback` what to say when it has none.
 */
export function apiErrorMessage(status: number, raw: unknown, fallback: string): string {
  const message = Array.isArray(raw) ? raw.join(". ") : typeof raw === "string" ? raw.trim() : "";
  if (status === 403 && (!message || DEFAULT_FORBIDDEN.has(message))) return FORBIDDEN_MESSAGE;
  return message || fallback;
}
