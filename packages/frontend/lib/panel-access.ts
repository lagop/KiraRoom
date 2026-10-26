/**
 * A professional's login to the panel, as the team screen shows and manages
 * it (backend: AdminProfessionalsService.grantPanelAccess). Pure, tested in
 * panel-access.spec.ts.
 */
export type PanelAccess =
  | { status: "none" }
  | { status: "owner"; email: string }
  | { status: "active" | "revoked"; email: string; lastLoginAt?: string | null };

/** Same minimum as signing in. */
export const MIN_PASSWORD = 8;

export function panelAccessText(access: PanelAccess | undefined): string {
  switch (access?.status) {
    case "active":
      return access.lastLoginAt
        ? `Entra con ${access.email}. Último acceso: ${new Date(access.lastLoginAt).toLocaleDateString("es-ES", {
            day: "numeric",
            month: "short",
          })}.`
        : `Entra con ${access.email}. Aún no ha entrado.`;
    case "revoked":
      return "Acceso quitado: no puede entrar al panel.";
    case "owner":
      return "Es la cuenta principal del salón.";
    default:
      return "Sin acceso al panel: no puede ver ni gestionar sus citas.";
  }
}

/** Why the first password cannot be used yet, or null. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Al menos ${MIN_PASSWORD} caracteres.`;
  if (password !== confirm) return "Las dos contraseñas no coinciden.";
  return null;
}

/** What the professional is told, so the owner can pass it on. */
export function accessInstructions(email: string, loginUrl: string): string {
  return [
    "Ya puedes entrar al panel de KiraRoom para ver y gestionar tus citas.",
    `Entra en ${loginUrl} con tu email (${email}) y la contraseña que te he dado.`,
    "Te recomiendo activar la verificación en dos pasos en Seguridad, en el menú.",
  ].join("\n");
}
