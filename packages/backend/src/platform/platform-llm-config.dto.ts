import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Body of `PUT /platform/llm-config` (SaaS owner). Absent leaves a field as
 * it is; null clears baseUrl and workspaceId; an empty apiKey keeps the
 * stored one. Was an inline type: a number where a string goes made the
 * service's `.trim()` throw.
 */
export class UpdatePlatformLlmConfigDto {
  /** Any string, for forward compatibility (see PlatformLlmConfigService). */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50)
  provider?: string;

  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  defaultModel?: string;

  @IsOptional() @IsUrl({ require_tld: false, require_protocol: true }) @MaxLength(2000)
  baseUrl?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  workspaceId?: string | null;
}

/** Body of `POST /platform/llm-config/anthropic/workspaces`: a key, never stored. */
export class AnthropicWorkspacesDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  apiKey!: string;
}
