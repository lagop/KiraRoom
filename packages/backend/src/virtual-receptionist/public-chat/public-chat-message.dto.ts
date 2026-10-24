import { Transform, Type } from "class-transformer";
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from "class-validator";

/**
 * Longest message a visitor can send. Each message goes to the model with the
 * conversation, so length is cost: the endpoint took any size before.
 */
export const PUBLIC_CHAT_MAX_MESSAGE = 1000;

export class PublicChatMetadataDto {
  /** The signed-in client's first name, for the greeting. Ignored for visitors. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  clientName?: string;

  /** The service the visitor was looking at, to suggest others. */
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

/**
 * POST /virtual-receptionist/messages from the chat on a salon's site.
 *
 * The controller declared the shared zod type, which class-validator cannot
 * see, so nothing was checked: any message length, any channel. A caller
 * could say `channel: "whatsapp"` with any `metadata.clientPhone`, and the
 * receptionist took that phone as verified and booked under it without asking.
 * WhatsApp reaches the receptionist through its webhook, never here, so this
 * endpoint only speaks for the web.
 *
 * Unknown fields are dropped by the global ValidationPipe (whitelist), which
 * is how clientEmail and clientPhone in older widgets stop mattering.
 */
export class PublicChatMessageDto {
  @IsUUID()
  salonId!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, PUBLIC_CHAT_MAX_MESSAGE)
  message!: string;

  @IsOptional()
  @IsIn(["web"])
  channel?: "web";

  /** Issued by a previous answer; see visitor-token.ts. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  visitorToken?: string;

  /**
   * What older widgets send. Only a `visitor-<uuid>` from before tokens is
   * used (once); a client is identified by their session, not by this.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PublicChatMetadataDto)
  metadata?: PublicChatMetadataDto;
}
