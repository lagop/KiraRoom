/**
 * Spanish validation messages for the SaaS console's DTOs (audit 8 T6): the
 * console shows the API's message as it comes, and class-validator's own
 * are in English ("email must be an email").
 */
export const CONSOLE_DTO_MESSAGES = {
  text: (field: string) => `El campo «${field}» tiene que ser un texto.`,
  url: (field: string) => `El campo «${field}» tiene que ser una dirección web completa (https://…).`,
  date: (field: string) => `El campo «${field}» tiene que ser una fecha válida (AAAA-MM-DD).`,
  boolean: (field: string) => `El campo «${field}» tiene que ser sí o no.`,
  plan: "Elige un plan válido: Esencial, Pro o Empresa.",
  status: "Elige un estado de suscripción válido.",
  nifType: "Elige un tipo de NIF válido.",
} as const;
