import { ParseUUIDPipe, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import {
  CreateLocationDto,
  MultiLocationService,
  UpdateLocationDto,
} from "./multi-location.service";

@ApiTags("multi-location")
@Controller("locations")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("multi_location")
export class MultiLocationController {
  constructor(private readonly service: MultiLocationService) {}

  @Get()
  @ApiOperation({ summary: "Listar locales del tenant" })
  @Roles(...SALON_MANAGERS)
  list(@Req() req: any) {
    return this.service.list(req.user.tenantId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Obtener un local" })
  @Roles(...SALON_MANAGERS)
  get(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.get(req.user.tenantId, id);
  }

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Crear un local (plan Empresa)" })
  create(@Req() req: any, @Body() dto: CreateLocationDto) {
    return this.service.create(req.user.tenantId, dto);
  }

  @Patch(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Actualizar un local" })
  update(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.service.update(req.user.tenantId, id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.owner)
  @ApiOperation({ summary: "Desactivar un local (soft delete)" })
  remove(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.remove(req.user.tenantId, id);
  }

  @Get(":id/stats")
  @ApiOperation({ summary: "KPIs del local (ultimos 30 dias)" })
  @Roles(...SALON_MANAGERS)
  stats(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.getStats(req.user.tenantId, id);
  }
}

@ApiTags("multi-location")
@Controller("multi-location")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
export class ConsolidatedReportsController {
  constructor(private readonly service: MultiLocationService) {}

  @Get("consolidated")
  @Feature("consolidated_reports")
  @ApiOperation({ summary: "KPIs agregados de todos los locales" })
  @Roles(...SALON_MANAGERS)
  consolidated(@Req() req: any) {
    return this.service.getConsolidated(req.user.tenantId);
  }
}