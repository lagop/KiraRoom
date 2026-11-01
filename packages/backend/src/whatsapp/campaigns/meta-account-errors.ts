/**
 * Meta errors that are about the salon's WhatsApp account or the campaign's
 * template, not about one client: an expired token, a payment problem, a
 * paused template, a restricted number. Every remaining message would fail
 * the same way, so the campaign is paused (with the reason in Spanish) and
 * the clients not yet reached stay pending, to be sent once the salon fixes
 * the cause and presses "Reanudar". Before, each of these was recorded as a
 * failure of that client, the batch went on, and the whole audience ended
 * up failed under a card that said "Enviada".
 *
 * Codes from Meta's Cloud API error reference.
 */

const RECONNECT = "Vuelve a conectar el WhatsApp en Ajustes → WhatsApp y pulsa Reanudar.";

export const DISCONNECTED_REASON = `El WhatsApp del salón se ha desconectado. ${RECONNECT}`;
export const TOKEN_EXPIRED_REASON =
  `El acceso de KiraRoom a tu cuenta de WhatsApp Business ha caducado o ya no es válido. ${RECONNECT}`;

const AUTH = new Set([
  0, // AuthException
  10, // permission denied
  102, // API session
  190, // access token expired or invalid
  131005, // access denied
]);
const PAYMENT = new Set([131042]); // business eligibility: payment issue
const RESTRICTED = new Set([
  368, // temporarily blocked for policy violations
  131031, // business account locked
  131045, // phone number not registered (certificate)
  131048, // spam rate limit: number restricted
  133010, // phone number not registered with the Cloud API
]);

function codeOf(reason: string | number | null | undefined): number | null {
  if (typeof reason === "number") return Number.isFinite(reason) ? reason : null;
  const match = /^meta_(\d+)$/.exec(reason ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Why a campaign must pause, in Spanish, for a send result's reason
 * ("meta_190", "not_connected"...) or a Meta error code; null when the
 * error is about that one client (wrong number, not on WhatsApp...).
 */
export function accountLevelReason(reason: string | number | null | undefined): string | null {
  if (reason === "not_connected") return DISCONNECTED_REASON;
  const code = codeOf(reason);
  if (code === null) return null;
  if (AUTH.has(code) || (code >= 200 && code <= 299)) return TOKEN_EXPIRED_REASON;
  if (PAYMENT.has(code)) {
    return "Meta no puede cobrar los mensajes: revisa el método de pago de tu cuenta de WhatsApp Business en Meta Business Suite y pulsa Reanudar.";
  }
  if (code === 132015) {
    return "Meta ha pausado la plantilla de esta campaña por su calidad (bloqueos o quejas de clientes). Cuando Meta la reactive, pulsa Reanudar.";
  }
  if (code === 132016) {
    return "Meta ha desactivado la plantilla de esta campaña por su calidad. No se podrá reanudar: crea una campaña nueva con otro texto.";
  }
  if (code === 132001) {
    return "La plantilla de esta campaña ya no existe en tu cuenta de WhatsApp Business. Crea la campaña de nuevo.";
  }
  if (RESTRICTED.has(code)) {
    return "Meta ha restringido o bloqueado el número de WhatsApp del salón. Revisa el estado de la cuenta en Meta Business Suite y pulsa Reanudar cuando esté resuelto.";
  }
  return null;
}
