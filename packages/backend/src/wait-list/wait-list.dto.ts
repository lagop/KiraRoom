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

export class WaitListCreateDto {
  @IsUUID()
  clientId!: string;

  @IsUUID()
  serviceId!: string;

  @IsOptional() @IsUUID()
  professionalId?: string | null;

  @IsOptional() @IsDateString()
  earliestDate?: string | null;

  @IsOptional() @IsDateString()
  latestDate?: string | null;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string | null;
}

export class WaitListUpdateDto {
  @IsOptional() @IsIn(WAIT_LIST_STATUSES as unknown as string[])
  status?: WaitListStatus;

  @IsOptional() @IsDateString()
  earliestDate?: string | null;

  @IsOptional() @IsDateString()
  latestDate?: string | null;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string | null;
}

/** The slot being offered. All optional: without it the notice just says there is room. */
export class NotifyWaitListDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  time?: string;

  @IsOptional() @IsUUID()
  professionalId?: string;
}

export class WaitListSettingsDto {
  @IsBoolean()
  autoNotify!: boolean;
}
