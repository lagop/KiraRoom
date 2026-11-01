import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

export const WAIT_LIST_STATUSES = ["waiting", "notified", "cancelled", "fulfilled"] as const;
export type WaitListStatus = (typeof WAIT_LIST_STATUSES)[number];

// The service checks that dates are real days (2026-02-30 is refused) and
// not in the past; these only check the shape, in Spanish.
const DATE = { message: "La fecha no es válida (AAAA-MM-DD)" };

export class WaitListCreateDto {
  @IsUUID("all", { message: "Elige un cliente" })
  clientId!: string;

  @IsUUID("all", { message: "Elige un servicio" })
  serviceId!: string;

  @IsOptional() @IsUUID("all", { message: "Profesional no válido" })
  professionalId?: string | null;

  @IsOptional() @IsDateString({}, DATE)
  earliestDate?: string | null;

  @IsOptional() @IsDateString({}, DATE)
  latestDate?: string | null;

  @IsOptional() @IsString() @MaxLength(500, { message: "La nota no puede pasar de 500 caracteres" })
  notes?: string | null;
}

export class WaitListUpdateDto {
  @IsOptional() @IsIn(WAIT_LIST_STATUSES as unknown as string[], { message: "Estado no válido" })
  status?: WaitListStatus;

  @IsOptional() @IsDateString({}, DATE)
  earliestDate?: string | null;

  @IsOptional() @IsDateString({}, DATE)
  latestDate?: string | null;

  @IsOptional() @IsString() @MaxLength(500, { message: "La nota no puede pasar de 500 caracteres" })
  notes?: string | null;
}

/** The slot being offered. All optional: without it the notice just says there is room. */
export class NotifyWaitListDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, DATE)
  date?: string;

  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "La hora no es válida (HH:MM)" })
  time?: string;

  @IsOptional() @IsUUID("all", { message: "Profesional no válido" })
  professionalId?: string;
}

export class WaitListSettingsDto {
  @IsBoolean()
  autoNotify!: boolean;
}
