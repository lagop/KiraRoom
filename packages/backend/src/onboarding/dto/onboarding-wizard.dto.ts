import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { OpeningHoursDto } from "../../auth/dto/update-tenant.dto";
import { IsWorkingHours } from "../../professionals/working-hours-input";
import type { WorkingHoursEntry } from "../../appointments/working-hours";

// Spanish messages: the wizard shows the server's text as it comes, and
// class-validator's own ("services.0.durationMinutes must not be less than
// 5") reached the owner (O14).
export class WizardServiceDto {
  @IsString({ message: "El nombre del servicio no es válido." })
  @IsNotEmpty({ message: "Escribe el nombre de cada servicio." })
  @MaxLength(200, { message: "El nombre del servicio es demasiado largo (máximo 200 caracteres)." })
  name!: string;

  @Type(() => Number)
  @IsInt({ message: "La duración de cada servicio tiene que ser un número entero de minutos." })
  @Min(5, { message: "Cada servicio tiene que durar al menos 5 minutos." })
  @Max(1440, { message: "Un servicio no puede durar más de 24 horas." })
  durationMinutes!: number;

  /** Euros, as Service.price. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "El precio tiene que ser un importe con 2 decimales como máximo." })
  @Min(0, { message: "El precio no puede ser negativo." })
  @Max(1_000_000, { message: "El precio es demasiado alto." })
  price!: number;

  @IsOptional()
  @IsString({ message: "La descripción no es válida." })
  @MaxLength(2000, { message: "La descripción es demasiado larga (máximo 2.000 caracteres)." })
  description?: string;
}

export class WizardFirstAppointmentDto {
  @IsString({ message: "El nombre de la clienta de prueba no es válido." })
  @IsNotEmpty({ message: "Escribe un nombre para la clienta de prueba." })
  @MaxLength(200, { message: "El nombre de la clienta es demasiado largo." })
  clientName!: string;

  @IsString({ message: "Elige el servicio de la cita de prueba." })
  @IsNotEmpty({ message: "Elige el servicio de la cita de prueba." })
  @MaxLength(200, { message: "El nombre del servicio es demasiado largo." })
  serviceName!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}/, { message: "La fecha de la cita de prueba no es válida." })
  date!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "La hora de la cita de prueba no es válida (HH:MM)." })
  time!: string;
}

/** The week as the wizard sends it: a day the salon is closed is absent or null. */
export class WizardWorkingWeekDto {
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) mon?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) tue?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) wed?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) thu?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) fri?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) sat?: OpeningHoursDto | null;
  @IsOptional() @ValidateNested() @Type(() => OpeningHoursDto) sun?: OpeningHoursDto | null;
}

/**
 * Body of `POST /onboarding/wizard`. It was an inline type: services went
 * into createMany with any duration and price, and `workingHours` replaced
 * the salon's openingHours with whatever JSON was sent.
 */
export class SubmitOnboardingWizardDto {
  @IsOptional()
  @IsArray({ message: "La lista de servicios no es válida." })
  @ArrayMaxSize(50, { message: "Puedes añadir hasta 50 servicios a la vez." })
  @ValidateNested({ each: true }) @Type(() => WizardServiceDto)
  services?: WizardServiceDto[];

  @IsOptional() @ValidateNested() @Type(() => WizardFirstAppointmentDto)
  firstAppointment?: WizardFirstAppointmentDto;

  /** One window per open day. Superseded by `openingHours`; still accepted. */
  @IsOptional() @ValidateNested() @Type(() => WizardWorkingWeekDto)
  workingHours?: WizardWorkingWeekDto;

  /**
   * The salon's week in the list format the settings page saves
   * ([{ day, openTime, closeTime }], several entries for a day being shifts),
   * so a salon that closes at midday can say so from the start. Used instead
   * of `workingHours` when both are sent; [] stores nothing.
   */
  @IsOptional() @IsWorkingHours()
  openingHours?: WorkingHoursEntry[];
}


/** Body of `POST /onboarding/events/booking-link-shared`: what was taken from Compartir. */
export class BookingLinkSharedDto {
  @IsOptional()
  @IsIn(["qr_download", "link_copy", "link_share", "widget_copy"], { message: "Acción no válida." })
  how?: "qr_download" | "link_copy" | "link_share" | "widget_copy";
}
