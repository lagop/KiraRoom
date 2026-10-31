import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidationArguments,
  registerDecorator,
} from "class-validator";
import { Transform } from "class-transformer";
import {
  DATE_PATTERN,
  REQUESTABLE_KINDS,
  TIME_OFF_KINDS,
  TIME_OFF_STATUSES,
  TIME_PATTERN,
  TimeOffKindName,
  TimeOffStatusName,
  timeOffInputProblem,
} from "../time-off-rules";

const DATE_MESSAGE = "Las fechas tienen que ser días válidos (AAAA-MM-DD).";
const TIME_MESSAGE = "Las horas tienen que ser HH:MM.";

/** "" from an emptied input is "no value", like a missing one. */
const emptyToNull = Transform(({ value }) => (value === "" ? null : value));
const trimmed = Transform(({ value }) => (typeof value === "string" ? value.trim() || null : value));

/**
 * The rules between fields (end after start, hours only on one day, a closure
 * has no professional, at most 366 days), on the whole body. Pair with a
 * create: an edit checks the merged row in the service instead.
 */
function IsTimeOffInput(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: "isTimeOffInput",
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (_value: unknown, args?: ValidationArguments) =>
          timeOffInputProblem(args?.object as any) === null,
        defaultMessage: (args?: ValidationArguments) =>
          timeOffInputProblem(args?.object as any) ?? "La ausencia no es válida.",
      },
    });
  };
}

/**
 * The same rules on a request's body, as the caller's own absence: any
 * professional id stands in for theirs (the DTO has none).
 */
function IsTimeOffRequest(): PropertyDecorator {
  const asOwn = (args?: ValidationArguments) => ({ ...(args?.object as any), professionalId: "self" });
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: "isTimeOffRequest",
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (_value: unknown, args?: ValidationArguments) => timeOffInputProblem(asOwn(args)) === null,
        defaultMessage: (args?: ValidationArguments) =>
          timeOffInputProblem(asOwn(args)) ?? "La solicitud no es válida.",
      },
    });
  };
}

/** POST /time-off and POST /time-off/preview. */
export class CreateTimeOffDto {
  /** Absent: the whole salon is closed (kind closure). */
  @ApiPropertyOptional({ description: "Absent or null: a closure of the whole salon" })
  @IsOptional()
  @IsUUID(undefined, { message: "El profesional no es válido." })
  professionalId?: string | null;

  @ApiProperty({ enum: TIME_OFF_KINDS })
  @IsIn(TIME_OFF_KINDS as unknown as string[], { message: "El tipo de ausencia no es válido." })
  kind!: TimeOffKindName;

  @ApiProperty({ example: "2026-12-24" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  startDate!: string;

  /** Inclusive. */
  @ApiProperty({ example: "2026-12-26" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  @IsTimeOffInput()
  endDate!: string;

  @ApiPropertyOptional({ example: "10:00", description: "With endTime: a few hours of one day" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  startTime?: string | null;

  @ApiPropertyOptional({ example: "12:00" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  endTime?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @trimmed
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: "La nota puede tener como máximo 200 caracteres." })
  note?: string | null;
}

/**
 * PATCH /time-off/:id. Who it is for is not editable: a different
 * professional is a different absence (delete it and record the new one).
 */
export class UpdateTimeOffDto {
  @ApiPropertyOptional({ enum: TIME_OFF_KINDS })
  @IsOptional()
  @IsIn(TIME_OFF_KINDS as unknown as string[], { message: "El tipo de ausencia no es válido." })
  kind?: TimeOffKindName;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  endDate?: string;

  @ApiPropertyOptional({ description: "null: all day" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  startTime?: string | null;

  @ApiPropertyOptional({ description: "null: all day" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  endTime?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @trimmed
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: "La nota puede tener como máximo 200 caracteres." })
  note?: string | null;
}

/** GET /time-off. */
export class TimeOffQueryDto {
  @ApiProperty({ example: "2026-12-01" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  from!: string;

  @ApiProperty({ example: "2026-12-31" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  to!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID(undefined, { message: "El profesional no es válido." })
  professionalId?: string;

  /** Owner and admin only (ignored for staff): pending requests as well. */
  @ApiPropertyOptional({ description: "true: pending requests too (owner and admin)" })
  @Transform(({ value }) => value === true || value === "true" || value === "1")
  @IsOptional()
  @IsBoolean()
  includePending?: boolean;
}

/**
 * POST /time-off/requests and its preview: a professional asking for time
 * off for themselves. There is no professional in it -- it is always the
 * caller's own, from the session; one sent anyway is dropped by the
 * ValidationPipe (whitelist) and never read.
 */
export class CreateTimeOffRequestDto {
  @ApiProperty({ enum: REQUESTABLE_KINDS })
  @IsIn(REQUESTABLE_KINDS as unknown as string[], {
    message: "Puedes pedir vacaciones, un día libre u otra ausencia. Una baja o un cierre los registra el responsable.",
  })
  kind!: TimeOffKindName;

  @ApiProperty({ example: "2026-12-24" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  startDate!: string;

  /** Inclusive. */
  @ApiProperty({ example: "2026-12-26" })
  @Matches(DATE_PATTERN, { message: DATE_MESSAGE })
  @IsTimeOffRequest()
  endDate!: string;

  @ApiPropertyOptional({ example: "10:00", description: "With endTime: a few hours of one day" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  startTime?: string | null;

  @ApiPropertyOptional({ example: "12:00" })
  @emptyToNull
  @IsOptional()
  @Matches(TIME_PATTERN, { message: TIME_MESSAGE })
  endTime?: string | null;

  @ApiPropertyOptional({ maxLength: 200, description: "For whoever runs the salon only" })
  @trimmed
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: "La nota puede tener como máximo 200 caracteres." })
  note?: string | null;
}

/** POST /time-off/:id/approve and /reject: an optional word for the requester. */
export class DecideTimeOffDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @trimmed
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: "El motivo puede tener como máximo 200 caracteres." })
  note?: string | null;
}

/** GET /time-off/requests. */
export class TimeOffRequestsQueryDto {
  @ApiPropertyOptional({ enum: TIME_OFF_STATUSES, default: "pending" })
  @IsOptional()
  @IsIn(TIME_OFF_STATUSES as unknown as string[], { message: "El estado no es válido." })
  status?: TimeOffStatusName;
}
