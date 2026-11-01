import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { PHONE_PATTERN } from "../../common/phone";
import { AppointmentServiceItemDto } from "./update-appointment.dto";

/**
 * Request bodies for POST /appointments (public) and POST /appointments/staff.
 *
 * Both routes used to take a TypeScript interface, which the ValidationPipe
 * cannot check: a missing field arrived as `undefined`, and Prisma drops an
 * `undefined` filter. `client.findFirst({ where: { email: undefined, tenantId } })`
 * matched the salon's first client, so an anonymous booking without an email
 * landed in someone else's name; a missing professionalId matched the first
 * professional of any salon.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Messages in Spanish: the booking forms show them to the client as they
// arrive, and "phone must be a phone number" reached people booking a
// haircut. NestJS puts a nested field's path in front ("clientInfo."); the
// frontend strips it (lib/public-booking.ts, bookingErrorMessage).
const PHONE_INVALID = "Introduce un teléfono válido (al menos 9 cifras)";
const PHONE_TOO_LONG = "El teléfono es demasiado largo";
const EMAIL_INVALID = "Introduce un email válido";

class ClientNameDto {
  @ApiProperty()
  @IsString({ message: "Escribe tu nombre" })
  @MinLength(1, { message: "Escribe tu nombre" })
  @MaxLength(100, { message: "El nombre es demasiado largo (máximo 100 caracteres)" })
  firstName!: string;

  @ApiProperty()
  @IsString({ message: "Los apellidos no son válidos" })
  @MaxLength(100, { message: "Los apellidos son demasiado largos (máximo 100 caracteres)" })
  lastName!: string;
}

// The two classes below share only the name on purpose: class-validator
// merges an ancestor's rules, and an inherited ValidateIf would switch off
// the online form's "phone is required".

/** The dashboard: email or phone, one of them identifies the client. */
export class BookingClientInfoDto extends ClientNameDto {
  @ApiPropertyOptional()
  @ValidateIf((o) => !!o.email || !o.phone)
  @IsEmail({}, { message: EMAIL_INVALID })
  email?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => !!o.phone || !o.email)
  @Matches(PHONE_PATTERN, { message: PHONE_INVALID })
  @MaxLength(30, { message: PHONE_TOO_LONG })
  phone?: string;
}

/**
 * Who books online, on the site or through the chat: a phone is required --
 * it is how the salon reaches them about a last-minute change -- and the
 * email is optional. Asking for an email in the chat was friction, and typed
 * addresses came out incomplete ("irene.ensayo@").
 */
export class OnlineClientInfoDto extends ClientNameDto {
  @ApiProperty()
  @IsDefined({ message: "El teléfono es obligatorio" })
  @Matches(PHONE_PATTERN, { message: PHONE_INVALID })
  @MaxLength(30, { message: PHONE_TOO_LONG })
  phone!: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.email !== undefined && o.email !== null && o.email !== "")
  @IsEmail({}, { message: EMAIL_INVALID })
  email?: string;
}

class BookingSlotDto {
  @ApiProperty()
  @IsUUID(undefined, { message: "Elige un servicio" })
  serviceId!: string;

  @ApiProperty({ example: "2026-10-01" })
  @Matches(DATE, { message: "Elige una fecha válida" })
  scheduledDate!: string;

  @ApiProperty({ example: "10:30" })
  @Matches(TIME, { message: "Elige una hora válida" })
  scheduledTime!: string;

  @ApiPropertyOptional()
  @IsString({ message: "Las notas no son válidas" })
  @MaxLength(2000, { message: "Las notas son demasiado largas (máximo 2000 caracteres)" })
  @IsOptional()
  notes?: string;

  /**
   * One of the salon's locations (multi-local), when the booking page asks
   * for one: every professional of the visit must work there. Left out, the
   * appointment is the professional's own location's.
   */
  @ApiPropertyOptional()
  @ValidateIf((o) => o.locationId !== undefined && o.locationId !== null && o.locationId !== "")
  @IsUUID(undefined, { message: "El local no es válido" })
  locationId?: string;

  /** Ignored: the server decides the salon. Accepted so old clients validate. */
  @ApiPropertyOptional({ description: "Ignored" })
  @IsString({ message: "El salón no es válido" })
  @IsOptional()
  tenantId?: string;
}

/** POST /appointments: the public site, the widget, the client portal. */
export class OnlineBookingDto extends BookingSlotDto {
  /**
   * Empty or absent means "any professional", which only the widget offers:
   * it then needs widgetInstanceId, which says which salon.
   */
  @ApiPropertyOptional()
  @ValidateIf((o) => o.professionalId !== undefined && o.professionalId !== "")
  @IsUUID(undefined, { message: "Elige un profesional" })
  professionalId?: string;

  /** Who is booking. No clientId here: an anonymous caller cannot book as an existing client. */
  @ApiProperty({ type: OnlineClientInfoDto })
  @IsDefined({ message: "Faltan tus datos de contacto" })
  @ValidateNested({ message: "Tus datos de contacto no son válidos" })
  @Type(() => OnlineClientInfoDto)
  clientInfo!: OnlineClientInfoDto;

  @ApiPropertyOptional({ enum: ["online", "widget"] })
  @IsIn(["online", "widget"], { message: "El origen de la reserva no es válido" })
  @IsOptional()
  source?: "online" | "widget";

  @ApiPropertyOptional()
  @IsUUID(undefined, { message: "El widget de reservas no es válido" })
  @IsOptional()
  widgetInstanceId?: string;

  /**
   * She ticked "No quiero recibir promociones ni novedades del salón por
   * email": recorded as a refusal (ConsentService.recordBookingChoices).
   * Unticked or absent records nothing.
   */
  @ApiPropertyOptional()
  @IsBoolean({ message: "La opción de promociones no es válida" })
  @IsOptional()
  refusesMarketingEmail?: boolean;

  /**
   * She ticked "Recibir los avisos de mi cita por WhatsApp" (shown only when
   * the salon has WhatsApp connected): her appointment notices go by
   * WhatsApp too, starting with this booking's confirmation.
   */
  @ApiPropertyOptional()
  @IsBoolean({ message: "La opción de avisos por WhatsApp no es válida" })
  @IsOptional()
  wantsWhatsAppNotices?: boolean;

  /**
   * She ticked the optional "Quiero recibir promociones de <salón> por
   * WhatsApp" (shown only when the salon has WhatsApp connected and its plan
   * includes WhatsApp campaigns): recorded as her opt-in, with the text
   * shown. Unticked or absent records nothing; it is not a refusal.
   */
  @ApiPropertyOptional()
  @IsBoolean({ message: "La opción de promociones por WhatsApp no es válida" })
  @IsOptional()
  wantsWhatsAppPromotions?: boolean;
}

/** POST /appointments/staff: the dashboard. */
export class StaffBookingDto extends BookingSlotDto {
  /**
   * Required from an owner or manager. A professional books on their own
   * agenda: the server fills it in, and refuses a colleague's unless the salon
   * allows cross-booking.
   */
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  /** An existing client of the salon, or clientInfo to find or create one. */
  @ApiPropertyOptional()
  @ValidateIf((o) => !o.clientInfo)
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ type: BookingClientInfoDto })
  @ValidateNested()
  @Type(() => BookingClientInfoDto)
  @IsOptional()
  clientInfo?: BookingClientInfoDto;

  // Owner or admin only: the service ignores it for a professional.
  @ApiPropertyOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  commissionRate?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  depositRequired?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  depositAmount?: number;

  // Sent by the drawer; the server uses the service's own price and duration.
  @ApiPropertyOptional({ description: "Ignored" })
  @IsNumber()
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ description: "Ignored" })
  @IsNumber()
  @IsOptional()
  duration?: number;

  /**
   * A visit of several services, in order, created with the appointment in
   * one transaction. Each row's professional defaults to the appointment's;
   * the server times the rows from the start and each service's duration
   * (parallel rows start with the visit). It used to take a second request,
   * and when that one failed the appointment stayed half-made.
   */
  @ApiPropertyOptional({ type: [AppointmentServiceItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AppointmentServiceItemDto)
  services?: AppointmentServiceItemDto[];

  /**
   * Book even though it is in the past or outside the professional's or the
   * salon's hours (a walk-in, a visit entered afterwards). Owner or manager
   * only, after the panel asked them to confirm; never past an overlap.
   */
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  allowOutsideHours?: boolean;
}
