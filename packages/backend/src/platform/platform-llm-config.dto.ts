import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { PLATFORM_LLM_MODELS, PLATFORM_LLM_PROVIDERS } from "./platform-llm-config.service";

/**
 * Body of `PUT /platform/llm-config` (SaaS owner). Absent leaves a field as
 * it is; null clears workspaceId; an empty apiKey keeps the stored one
 * ("Quitar" is DELETE /platform/llm-config/api-key). There is no base URL:
 * the receptionist always calls Anthropic's own API, and a URL used only by
 * the connection test could send the key anywhere (audit 8 P5).
 *
 * Anthropic only, with one of the Claude models (audit 8 D9).
 */
export class UpdatePlatformLlmConfigDto {
  @IsOptional() @IsString() @IsIn(PLATFORM_LLM_PROVIDERS, { message: "La recepcionista solo funciona con Anthropic." })
  provider?: string;

  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString() @IsNotEmpty()
  @IsIn(PLATFORM_LLM_MODELS, { message: "Elige uno de los modelos de Claude de la lista." })
  defaultModel?: string;

  @IsOptional() @IsString() @MaxLength(200)
  workspaceId?: string | null;
}

/** Body of `POST /platform/llm-config/test`: the typed values, tested without saving them. */
export class TestPlatformLlmConfigDto {
  @IsOptional() @IsString() @IsIn(PLATFORM_LLM_PROVIDERS, { message: "La recepcionista solo funciona con Anthropic." })
  provider?: string;

  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString()
  @IsIn(PLATFORM_LLM_MODELS, { message: "Elige uno de los modelos de Claude de la lista." })
  defaultModel?: string;

  @IsOptional() @IsString() @MaxLength(200)
  workspaceId?: string | null;
}

/** Body of `POST /platform/llm-config/anthropic/workspaces`: a key, never stored. */
export class AnthropicWorkspacesDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;
}
