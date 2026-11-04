import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

/**
 * Bodies of the session routes, which were inline types. The handlers
 * already checked types by hand; these classes make the pipe do it and
 * cap the strings (the impersonation reason goes into the audit log).
 */
export class ImpersonateDto {
  @IsString() @IsNotEmpty() @MaxLength(4000)
  token!: string;

  /**
   * Ignored: the reason is signed into the token by the console (audit 8,
   * C17). Still accepted, capped, so an older console tab does not get a 400.
   */
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** The token normally comes from its cookie; see AuthController.refreshToken. */
export class RefreshTokenDto {
  @IsOptional() @IsString() @MaxLength(4000)
  refreshToken?: string;

  /**
   * "client" on a salon's site; "support" in the tab where the platform owner
   * is inside a salon (with tenantId); anything else is the staff panel.
   */
  @IsOptional() @IsString() @MaxLength(20)
  kind?: string;

  /** The salon of a support session's tab (kind "support"). */
  @IsOptional() @IsUUID()
  tenantId?: string;
}

export class LogoutDto {
  @IsOptional() @IsBoolean()
  everywhere?: boolean;
}
