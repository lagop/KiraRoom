import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Body of `PUT /platform/llm-config` (SaaS owner). Absent leaves a field as
 * it is; null clears workspaceId; an empty apiKey keeps the stored one
 * ("Quitar" is DELETE /platform/llm-config/api-key). There is no base URL:
 * the receptionist always calls Anthropic's own API, and a URL used only by
 * the connection test could send the key anywhere (audit 8 P5).
 */
export class UpdatePlatformLlmConfigDto {
  /** Any string, for forward compatibility (see PlatformLlmConfigService). */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50)
  provider?: string;

  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  defaultModel?: string;

  @IsOptional() @IsString() @MaxLength(200)
  workspaceId?: string | null;
}

/** Body of `POST /platform/llm-config/test`: the typed values, tested without saving them. */
export class TestPlatformLlmConfigDto {
  @IsOptional() @IsString() @MaxLength(50)
  provider?: string;

  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString() @MaxLength(200)
  defaultModel?: string;

  @IsOptional() @IsString() @MaxLength(200)
  workspaceId?: string | null;
}

/** Body of `POST /platform/llm-config/anthropic/workspaces`: a key, never stored. */
export class AnthropicWorkspacesDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;
}
