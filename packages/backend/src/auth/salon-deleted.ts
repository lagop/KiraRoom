/**
 * What the team of a salon deleted from the platform console reads when it
 * tries to sign in or its session is refused (audit 7 N7).
 */
export const SALON_DELETED_MESSAGE =
  "Este salón se ha dado de baja en KiraRoom y ya no se puede entrar. Si crees que es un error, escríbenos.";

/**
 * A salon blocked from the console (audit 8 D4, abuse). Neutral on purpose:
 * it does not say why, nor that it was blocked.
 */
export const SALON_BLOCKED_MESSAGE =
  "Ahora mismo no se puede entrar en este salón. Si crees que es un error, escríbenos a info@kiraroom.com.";
