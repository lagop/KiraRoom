import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, IsOptional, IsIn, IsUrl, IsEmail, IsInt, Min, Max, Matches, IsTimeZone, IsBoolean } from "class-validator";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { IsWorkingHours } from "../../professionals/working-hours-input";
import { BOOKING_SLOT_MINUTES, type WorkingHoursEntry } from "../../appointments/working-hours";
import {
  IsFacebookProfile,
  IsInstagramProfile,
  facebookProfileUrl,
  instagramProfileUrl,
  socialLinkInput,
} from "../../common/social-links";

/**
 * One HH:MM, 24-hour window. The onboarding wizard sends one per weekday; the
 * settings page used to send one for the whole salon as `openingHours`.
 */
export class OpeningHoursDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  open: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  close: string;
}

export class UpdateTenantDto {
  @ApiPropertyOptional({ description: "Public contact email" })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: "Minimum notice to cancel, in hours" })
  @IsInt()
  @Min(0)
  @Max(720)
  @IsOptional()
  minCancelHours?: number;

  // The salon's own week, in the format of a professional's workingHours:
  // [{ day: "monday", openTime: "10:00", closeTime: "14:00" }, ...], several
  // entries for a day being shifts, a day without entries closed. [] means
  // no salon-level hours (each professional's own schedule decides). The
  // old single { open, close } is still accepted and stored as that window
  // every day of the week.
  @ApiPropertyOptional({
    description:
      "Salon opening hours per weekday: [{ day, openTime, closeTime }]; [] = no salon-level hours. " +
      "A legacy { open, close } is stored as that window every day.",
  })
  @IsOptional()
  @IsWorkingHours({ legacyOpeningPair: true })
  openingHours?: WorkingHoursEntry[];

  // The step between the start times offered when booking (getAvailableSlots).
  @ApiPropertyOptional({ description: "Minutes between bookable start times", enum: BOOKING_SLOT_MINUTES })
  @IsOptional()
  @IsInt()
  @IsIn([...BOOKING_SLOT_MINUTES])
  bookingSlotMinutes?: number;

  @ApiPropertyOptional({ description: "Online bookings start confirmed instead of pending" })
  @IsOptional()
  @IsBoolean()
  autoConfirmOnlineBookings?: boolean;

  // Linked from the salon's public page. A handle ("@salonana") or a profile
  // link is stored as the canonical URL; blank or null clears it.
  @ApiPropertyOptional({ description: "Instagram: @handle or profile URL; blank clears it", nullable: true })
  @Transform(({ value }) => socialLinkInput(instagramProfileUrl)(value))
  @IsOptional()
  @IsInstagramProfile({ message: "Instagram: escribe tu usuario (@tusalon) o el enlace a tu perfil" })
  instagram?: string | null;

  @ApiPropertyOptional({ description: "Facebook: page name or page URL; blank clears it", nullable: true })
  @Transform(({ value }) => socialLinkInput(facebookProfileUrl)(value))
  @IsOptional()
  @IsFacebookProfile({ message: "Facebook: escribe el nombre de tu página o el enlace a ella" })
  facebook?: string | null;

  @ApiPropertyOptional({ description: "Tenant name" })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: "Tenant description" })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: "Tenant language", enum: ["es", "en"] })
  @IsString()
  @IsIn(["es", "en"])
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({ description: "Tenant currency" })
  @IsString()
  @IsOptional()
  currency?: string;

  // A zone the runtime does not know made every salon-time computation
  // (reminders, availability, the calendar) throw a RangeError.
  @ApiPropertyOptional({ description: "Tenant timezone (IANA, e.g. Atlantic/Canary)" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ description: "Tenant date format" })
  @IsString()
  @IsOptional()
  dateFormat?: string;

  @ApiPropertyOptional({ description: "Tenant time format" })
  @IsString()
  @IsOptional()
  timeFormat?: string;

  // ─── Identity fields used by the onboarding wizard (workspace_business) ───
  // These are persisted on Tenant and read by the `hasBusinessIdentity`
  // detector to mark the linear_required step done. Keep in sync with
  // `prisma/schema.prisma` Tenant model + OnboardingDetectorService.

  @ApiPropertyOptional({ description: "Tenant street address" })
  @IsString()
  @IsOptional()
  street?: string;

  @ApiPropertyOptional({ description: "Tenant city" })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ description: "Tenant phone number" })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: "Tenant logo URL or data: URL" })
  @IsString()
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ description: "Tenant postal code" })
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional({ description: "Tenant state / province" })
  @IsString()
  @IsOptional()
  state?: string;
}
