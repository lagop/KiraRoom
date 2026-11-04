import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
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

export class TestLlmProviderDto {
  @IsEnum(LLMProvider)
  provider!: LLMProvider;

  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;

  @IsOptional() @IsString() @MaxLength(200)
  model?: string;
}
