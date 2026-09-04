import { ParseUUIDPipe, Controller, Get, Patch, Body, UseGuards, Req } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { AdminSettingsService } from "./settings.service";
import { Request } from "express";

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    tenantId: string;
    role: UserRole;
  };
}

@ApiTags("Admin - Settings")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner, UserRole.admin)
@Controller("admin/settings")
export class AdminSettingsController {
  constructor(private readonly adminSettingsService: AdminSettingsService) {}

  @Get("professional-cross-booking")
  @ApiOperation({ summary: "Get professional cross-booking setting" })
  @ApiResponse({ status: 200, description: "Setting retrieved successfully" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async getProfessionalCrossBooking(@Req() req: AuthenticatedRequest) {
    return this.adminSettingsService.getProfessionalCrossBooking(
      req.user.tenantId,
    );
  }

  @Patch("professional-cross-booking")
  @ApiOperation({ summary: "Update professional cross-booking setting" })
  @ApiResponse({ status: 200, description: "Setting updated successfully" })
  @ApiResponse({ status: 400, description: "Invalid input" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async updateProfessionalCrossBooking(
    @Req() req: AuthenticatedRequest,
    @Body() body: { allowProfessionalCrossBooking: boolean },
  ) {
    return this.adminSettingsService.updateProfessionalCrossBooking(
      req.user.tenantId,
      body.allowProfessionalCrossBooking,
    );
  }
}
