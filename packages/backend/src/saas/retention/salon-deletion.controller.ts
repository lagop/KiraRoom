import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { AllowWhenReadOnly } from "../../common/decorators/allow-when-read-only.decorator";
import { SalonDeletionService } from "./salon-deletion.service";

export class RequestSalonDeletionDto {
  @IsString()
  @MaxLength(200)
  password!: string;

  /** The 2FA app's code (or a recovery code), when two-step verification is on. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;
}

/** "Borrar mi salón" in Ajustes > Seguridad (audit 7 D7). Owner only. */
@ApiTags("Settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner)
@Controller("settings/salon-deletion")
export class SalonDeletionController {
  constructor(private readonly deletion: SalonDeletionService) {}

  @Get()
  @ApiOperation({ summary: "Whether a deletion is pending, and its dates" })
  status(@CurrentUser() user: any) {
    return this.deletion.status(user.tenantId, user.id);
  }

  @Post()
  // A read-only salon can be deleted too.
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete the salon: read-only now, anonymised 30 days after" })
  request(@CurrentUser() user: any, @Body() dto: RequestSalonDeletionDto) {
    return this.deletion.request(user.tenantId, { id: user.id, role: user.role }, dto);
  }

  @Delete()
  // Pending deletion means read-only: cancelling it must work then.
  @AllowWhenReadOnly()
  @ApiOperation({ summary: "Cancel a pending deletion" })
  cancel(@CurrentUser() user: any) {
    return this.deletion.cancel(user.tenantId, { id: user.id, role: user.role });
  }
}
