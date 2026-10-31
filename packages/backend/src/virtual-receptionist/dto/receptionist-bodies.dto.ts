import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { LLMProvider } from "@kira/shared";

/**
 * Bodies of the receptionist's management routes. They were typed with the
 * zod-inferred types from @kira/shared: type aliases, which reach the
 * ValidationPipe as `Object` and are not validated, so `new
 * ValidationPipe()` on the parameter checked nothing. These classes carry
 * the same rules as the shared schemas, plus length limits.
 */

export class CreateFaqItemDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  question!: string;

  @IsString() @IsNotEmpty() @MaxLength(5000)
  answer!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  category!: string;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true })
  keywords?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10)
  priority?: number;
}

export class UpdateFaqItemDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500)
  question?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(5000)
  answer?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100)
  category?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true })
  keywords?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10)
  priority?: number;
}

/**
 * A conversation opened from the panel. The salon is the caller's (the
 * controller sets it): the body used to name `salonId` and `tenantId`.
 */
export class CreateConversationBodyDto {
  @IsUUID()
  clientId!: string;

  @IsIn(["whatsapp", "web"])
  channel!: "whatsapp" | "web";

  @IsOptional() @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateConversationBodyDto {
  @IsOptional() @IsIn(["active", "completed", "handoff"])
  status?: "active" | "completed" | "handoff";

  @IsOptional() @IsUUID()
  handoffUserId?: string;

  @IsOptional() @Type(() => Date) @IsDate()
  handoffAt?: Date;
}

export class CreateLlmProviderConfigDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsEnum(LLMProvider)
  provider!: LLMProvider;

  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;

  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(2000)
  baseUrl?: string;

  @IsString() @IsNotEmpty() @MaxLength(200)
  defaultModel!: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(200, { each: true })
  supportedModels!: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(8000)
  maxTokens?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(2)
  temperature?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000)
  rateLimit?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UpdateLlmProviderConfigDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @IsEnum(LLMProvider)
  provider?: LLMProvider;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsUrl({ require_tld: false }) @MaxLength(2000)
  baseUrl?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  defaultModel?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(200, { each: true })
  supportedModels?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(8000)
  maxTokens?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(2)
  temperature?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000)
  rateLimit?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class TestLlmProviderDto {
  @IsEnum(LLMProvider)
  provider!: LLMProvider;

  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;

  @IsOptional() @IsString() @MaxLength(200)
  model?: string;
}
