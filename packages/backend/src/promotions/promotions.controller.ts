import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Req } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import {
  PromotionsService,
  CreatePromotionDto,
  UpdatePromotionDto,
  ApplyPromotionDto,
} from "./promotions.service";
import { Request } from "express";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

interface AuthenticatedRequest extends Request {
  user: {
    tenantId: string;
    userId: string;
  };
}

@ApiTags("Promotions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("promotions")
@Controller("promotions")
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Create a new promotion" })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePromotionDto,
  ) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.create(tenantId, dto);
  }

  @Get()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get all promotions" })
  async getAll(@Req() req: AuthenticatedRequest) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.getAll(tenantId);
  }

  @Get("statistics")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get promotion usage statistics" })
  @ApiQuery({ name: "promotionId", required: false })
  async getStatistics(
    @Req() req: AuthenticatedRequest,
    @Query("promotionId") promotionId?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.getStatistics(tenantId, promotionId);
  }

  @Get("validate/:code")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Validate a promotion code without applying" })
  async validateCode(
    @Req() req: AuthenticatedRequest,
    @Param("code") code: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.validateCode(tenantId, code);
  }

  @Get(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Get a single promotion" })
  async getOne(@Req() req: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.getOne(id, tenantId);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update a promotion" })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.update(id, tenantId, dto);
  }

  @Delete(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Delete a promotion" })
  async delete(@Req() req: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.delete(id, tenantId);
  }

  @Post("apply")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  @ApiOperation({ summary: "Apply a promotion code" })
  async apply(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApplyPromotionDto,
  ) {
    const tenantId = req.user.tenantId;
    return this.promotionsService.applyPromotion(tenantId, dto);
  }
}
