import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

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

export class BookingClientInfoDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(30)
  @IsOptional()
  phone?: string;
}

class BookingSlotDto {
  @ApiProperty()
  @IsUUID()
  serviceId!: string;

  @ApiProperty({ example: "2026-10-01" })
  @Matches(DATE, { message: "scheduledDate must be YYYY-MM-DD" })
  scheduledDate!: string;

  @ApiProperty({ example: "10:30" })
  @Matches(TIME, { message: "scheduledTime must be HH:MM" })
  scheduledTime!: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  /** Ignored: the server decides the salon. Accepted so old clients validate. */
  @ApiPropertyOptional({ description: "Ignored" })
  @IsString()
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
  @IsUUID()
  professionalId?: string;

  /** Who is booking. No clientId here: an anonymous caller cannot book as an existing client. */
  @ApiProperty({ type: BookingClientInfoDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => BookingClientInfoDto)
  clientInfo!: BookingClientInfoDto;

  @ApiPropertyOptional({ enum: ["online", "widget"] })
  @IsIn(["online", "widget"])
  @IsOptional()
  source?: "online" | "widget";

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  widgetInstanceId?: string;
}

/** POST /appointments/staff: the dashboard. */
export class StaffBookingDto extends BookingSlotDto {
  @ApiProperty()
  @IsUUID()
  professionalId!: string;

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

  @ApiPropertyOptional()
  @IsNumber()
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
}
