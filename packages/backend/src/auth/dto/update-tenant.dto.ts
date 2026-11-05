import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, IsOptional, IsIn, IsUrl, IsEmail, IsInt, Min, Max, MaxLength, Matches, IsTimeZone, IsBoolean } from "class-validator";
import { CANCELLATION_POLICY_MAX } from "../../virtual-receptionist/prompts/templates";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { PHONE_PATTERN } from "../../common/phone";
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
/**
 * Blank (or null) clears the field: stored as null. The settings pages used
 * to send blanks as undefined, which left the old text on the public page.
 */
const BlankToNull = () =>
  Transform(({ value }) => (value === null || (typeof value === "string" && value.trim() === "") ? null : value));

/** The rule the booking form uses for a client's phone (common/phone.ts). */
export const TENANT_PHONE_INVALID = "Introduce un teléfono válido (al menos 9 cifras)";

export class OpeningHoursDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  open: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  close: string;
}

export class UpdateTenantDto {
  @ApiPropertyOptional({ description: "Public contact email; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsEmail({}, { message: "Introduce un correo electrónico válido o déjalo vacío" })
  email?: string | null;

  // Informational: the receptionist tells clients; nothing charges a fee or
  // stops a cancellation. 0 = no minimum ("Sin política").
  @ApiPropertyOptional({ description: "Notice the salon asks for to cancel, in hours (informational); 0 = none" })
  @IsInt()
  @Min(0)
  @Max(720)
  @IsOptional()
  minCancelHours?: number;

  @ApiPropertyOptional({
    description: "The salon's cancellation policy, in its own words (informational); blank or null clears it",
    nullable: true,
  })
  @BlankToNull()
  @IsOptional()
  @IsString()
  @MaxLength(CANCELLATION_POLICY_MAX, {
    message: `La política de cancelación puede tener como mucho ${CANCELLATION_POLICY_MAX} caracteres`,
  })
  cancellationPolicy?: string | null;

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

  @ApiPropertyOptional({ description: "Time off requests and answers by email too, besides the panel" })
  @IsOptional()
  @IsBoolean()
  timeOffEmailNotices?: boolean;

  @ApiPropertyOptional({ description: "Ajustes > Recepcionista: the receptionist chat on the salon's public page" })
  @IsOptional()
  @IsBoolean()
  webChatEnabled?: boolean;

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

  @ApiPropertyOptional({ description: "Tenant description; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: "Tenant language", enum: ["es", "en"] })
  @IsString()
  @IsIn(["es", "en"])
  @IsOptional()
  language?: string;

  // No currency, dateFormat or timeFormat: the product is euros, DD/MM/YYYY
  // and 24 h, and those settings changed nothing. The global ValidationPipe
  // strips them (whitelist), so an old tab that still sends them saves fine.

  // A zone the runtime does not know made every salon-time computation
  // (reminders, availability, the calendar) throw a RangeError.
  @ApiPropertyOptional({ description: "Tenant timezone (IANA, e.g. Atlantic/Canary)" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

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

  @ApiPropertyOptional({ description: "Tenant phone number; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: TENANT_PHONE_INVALID })
  phone?: string | null;

  @ApiPropertyOptional({ description: "Tenant logo URL or data: URL" })
  @IsString()
  @IsOptional()
  logo?: string;

  /**
   * The cover photo of the salon's public page and booking widget (the
   * onboarding "Imagen de portada" step). Only the SaaS console could set
   * it before, so that step could never be completed by the salon.
   */
  @ApiPropertyOptional({ description: "Cover image URL or data: URL; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  @MaxLength(1_500_000)
  coverImage?: string | null;

  @ApiPropertyOptional({ description: "Tenant postal code; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  postalCode?: string | null;

  @ApiPropertyOptional({ description: "Tenant state / province; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  state?: string | null;

  /**
   * The salon's own website, if it has one: linked from its page, and the
   * first allowed origin offered when it creates a booking widget.
   */
  @ApiPropertyOptional({ description: "The salon's own website (https); blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsUrl(
    { protocols: ["https", "http"], require_protocol: true },
    { message: "Escribe la dirección completa de tu web, como https://misalon.com" },
  )
  @MaxLength(500)
  website?: string | null;

  /** "Escríbenos por WhatsApp" on the salon's page (a wa.me link). */
  @ApiPropertyOptional({ description: "WhatsApp number for the public page's button; blank or null clears it", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: TENANT_PHONE_INVALID })
  whatsapp?: string | null;

  /**
   * "URL de mi propia política de privacidad": when set, the salon's page,
   * widget and chat link there instead of the page KiraRoom generates
   * (/sites/<slug>/privacidad).
   */
  @ApiPropertyOptional({ description: "The salon's own privacy policy (https); blank or null: the generated one", nullable: true })
  @BlankToNull()
  @IsOptional()
  @IsUrl(
    { protocols: ["https"], require_protocol: true },
    { message: "La política de privacidad tiene que ser una dirección https, como https://misalon.com/privacidad" },
  )
  @MaxLength(500)
  privacyPolicyUrl?: string | null;
}
