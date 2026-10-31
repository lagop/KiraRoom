import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
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

export class WizardServiceDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @Type(() => Number) @IsInt() @Min(5) @Max(1440)
  durationMinutes!: number;

  /** Euros, as Service.price. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000)
  price!: number;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;
}

export class WizardFirstAppointmentDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  clientName!: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  serviceName!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}/)
  date!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
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
  @IsOptional() @IsArray() @ArrayMaxSize(50)
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
