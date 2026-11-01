import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { Response } from "express";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { AllowWhenReadOnly } from "../../common/decorators/allow-when-read-only.decorator";
import { ClientGdprService } from "../../clients/client-gdpr.service";

/**
 * A client's RGPD rights, exercised by the salon (the data controller) on
 * her behalf: a copy of her data, and erasure. Owner / admin only; staff
 * never reach these.
 */
@ApiTags("Admin - Clients")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.owner, UserRole.admin)
@Controller("admin/clients")
export class AdminClientGdprController {
  constructor(private readonly gdpr: ClientGdprService) {}

  @Get(":id/export")
  @ApiOperation({ summary: "Everything the salon holds about a client, as a JSON download (RGPD arts. 15 and 20)" })
  @ApiResponse({ status: 200, description: "JSON document, as an attachment" })
  @ApiResponse({ status: 404, description: "Client not found" })
  async export(
    @CurrentUser() user: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const document = await this.gdpr.export(user.tenantId, id, { id: user.id, role: user.role });
    const day = document.generatedAt.slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="datos-clienta-${id}-${day}.json"`);
    res.setHeader("Cache-Control", "no-store");
    return document;
  }

  @Post(":id/anonymize")
  // Erasure is a right the salon must honour even while its subscription is read-only.
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Erase a client's personal data, keeping visits and invoices (RGPD art. 17)" })
  @ApiResponse({ status: 200, description: "Anonymised" })
  @ApiResponse({ status: 404, description: "Client not found" })
  @ApiResponse({ status: 409, description: "She has upcoming appointments" })
  async anonymize(@CurrentUser() user: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.gdpr.anonymize(user.tenantId, id, { id: user.id, role: user.role });
  }
}
