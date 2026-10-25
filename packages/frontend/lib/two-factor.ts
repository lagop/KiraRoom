/**
 * Two-step verification, browser side: the text file of recovery codes the
 * settings screen offers to download. Pure, tested in two-factor.spec.ts.
 */
export function recoveryCodesFile(codes: string[], when: Date): string {
  const date = when.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
  return [
    "KiraRoom: códigos de recuperación de la verificación en dos pasos",
    `Generados el ${date}.`,
    "",
    "Cada código sirve una sola vez para entrar si no tienes el móvil.",
    "Guárdalos en un sitio seguro y no los compartas.",
    "",
    ...codes,
    "",
  ].join("\n");
}
