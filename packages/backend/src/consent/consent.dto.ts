import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";

export const CONSENT_FIELD_TYPES = ["boolean", "text", "select", "date", "info"] as const;

/**
 * One field of a consent form. Its `label` can be a paragraph of legal
 * text (an "info" field), hence the note-sized limit.
 */
export class ConsentFormFieldDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  id!: string;

  @IsIn(CONSENT_FIELD_TYPES as unknown as string[])
  type!: (typeof CONSENT_FIELD_TYPES)[number];

  @IsString() @MaxLength(5000)
  label!: string;

  @IsOptional() @IsBoolean()
  required?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(200, { each: true })
  options?: string[];

  @IsOptional() @IsString() @MaxLength(5000)
  helpText?: string;
}

/**
 * Body of `POST /consent-forms`. Was `any`: the service picks the columns,
 * but `fields` went into a JSON column as sent (any shape, any size) and
 * `serviceIds` could hold anything.
 */
export class CreateConsentFormDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => ConsentFormFieldDto)
  fields!: ConsentFormFieldDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  serviceIds?: string[];
}

/** Body of `PATCH /consent-forms/:id`: a new version from any of these. */
export class UpdateConsentFormDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => ConsentFormFieldDto)
  fields?: ConsentFormFieldDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  serviceIds?: string[];
}

/**
 * Body of the public `POST /consent/sign`. Was `any`; the service checks
 * the form and the client belong to the salon, and caps `responses`.
 */
export class SignConsentDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  clientId!: string;

  @IsUUID()
  formId!: string;

  @IsOptional() @IsObject()
  responses?: Record<string, unknown>;

  @IsString() @MinLength(2) @MaxLength(200)
  signatureName!: string;

  @IsOptional() @IsUUID()
  appointmentId?: string;

  @IsOptional() @IsUUID()
  serviceId?: string;
}

/** Body of `POST /consent/:id/revoke`. */
export class RevokeConsentDto {
  @IsOptional() @IsString() @MaxLength(2000)
  reason?: string;
}
