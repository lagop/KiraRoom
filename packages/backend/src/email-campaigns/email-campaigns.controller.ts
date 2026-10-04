import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { EmailCampaignsService } from "./email-campaigns.service";
import {
  CreateCampaignDto,
  UpdateCampaignDto,
  CreateTemplateDto,
  SendCampaignDto,
  AddRecipientsDto,
  ScheduleCampaignDto,
  CreateReengagementCampaignDto,
} from "./dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User, UserRole } from "@prisma/client";
import { PromotionsService } from "../promotions/promotions.service";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

@ApiTags("Email Campaigns")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("email-campaigns")
@Feature("email_marketing")
export class EmailCampaignsController {
  constructor(
    private readonly campaignsService: EmailCampaignsService,
    private readonly promotionsService: PromotionsService,
  ) {}

  // ============ CAMPAIGNS ============

  @Get()
  @ApiOperation({ summary: "Get all email campaigns" })
  @ApiResponse({ status: 200, description: "List of campaigns" })
  @Roles(...SALON_MANAGERS)
  async getCampaigns(
    @CurrentUser() user: User,
    @Query("status") status?: string,
    @Query("campaignType") campaignType?: string,
  ) {
    return this.campaignsService.getCampaigns(
      user.tenantId,
      status,
      campaignType,
    );
  }

  // Declared before ":id", which would otherwise take "tracking-status"
  // and fail its UUID check.
  @Get("tracking-status")
  @ApiOperation({ summary: "Whether sending and delivery tracking are configured" })
  @Roles(...SALON_MANAGERS)
  async getTrackingStatus(@CurrentUser() user: User) {
    return this.campaignsService.getTrackingStatus(user.tenantId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get campaign by ID" })
  @ApiResponse({ status: 200, description: "Campaign details" })
  @Roles(...SALON_MANAGERS)
  async getCampaign(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaign(user.tenantId, id);
  }

  @Get(":id/recipients")
  @ApiOperation({ summary: "Get campaign recipients" })
  @ApiResponse({ status: 200, description: "List of campaign recipients" })
  @Roles(...SALON_MANAGERS)
  async getRecipients(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignRecipients(user.tenantId, id);
  }

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Create new campaign" })
  @ApiResponse({ status: 201, description: "Campaign created" })
  async createCampaign(
    @CurrentUser() user: User,
    @Body() dto: CreateCampaignDto,
  ) {
    return this.campaignsService.createCampaign(user.tenantId, dto);
  }

  @Put(":id")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Update campaign" })
  @ApiResponse({ status: 200, description: "Campaign updated" })
  async updateCampaign(
    @CurrentUser() user: User,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.campaignsService.updateCampaign(user.tenantId, id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.owner)
  @ApiOperation({ summary: "Delete campaign (Owner only)" })
  @ApiResponse({ status: 200, description: "Campaign deleted" })
  async deleteCampaign(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.deleteCampaign(user.tenantId, id);
  }

  @Post(":id/schedule")
  @ApiOperation({ summary: "Schedule campaign" })
  @ApiResponse({ status: 200, description: "Campaign scheduled" })
  @Roles(...SALON_MANAGERS)
  async scheduleCampaign(
    @CurrentUser() user: User,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ScheduleCampaignDto,
  ) {
    return this.campaignsService.scheduleCampaign(
      user.tenantId,
      id,
      new Date(dto.scheduledAt),
    );
  }

  @Post(":id/send")
  @ApiOperation({ summary: "Send campaign now" })
  @ApiResponse({ status: 200, description: "Campaign sent" })
  @Roles(...SALON_MANAGERS)
  async sendCampaign(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.sendCampaignNow(user.tenantId, id);
  }

  @Post(":id/recipients")
  @ApiOperation({ summary: "Add recipients to campaign" })
  @ApiResponse({ status: 201, description: "Recipients added" })
  @Roles(...SALON_MANAGERS)
  async addRecipients(
    @CurrentUser() user: User,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AddRecipientsDto,
  ) {
    return this.campaignsService.addRecipients(
      user.tenantId,
      id,
      dto.clientIds,
    );
  }

  @Delete(":id/recipients")
  @ApiOperation({ summary: "Remove recipients from campaign" })
  @ApiResponse({ status: 200, description: "Recipients removed" })
  @Roles(...SALON_MANAGERS)
  async removeRecipients(
    @CurrentUser() user: User,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AddRecipientsDto,
  ) {
    return this.campaignsService.removeRecipients(
      user.tenantId,
      id,
      dto.clientIds,
    );
  }

  @Get(":id/analytics")
  @ApiOperation({ summary: "Get campaign analytics" })
  @ApiResponse({ status: 200, description: "Campaign analytics" })
  @Roles(...SALON_MANAGERS)
  async getAnalytics(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignAnalytics(user.tenantId, id);
  }

  // ============ TEMPLATES ============

  @Get("templates/list")
  @ApiOperation({ summary: "Get all templates" })
  @ApiResponse({ status: 200, description: "List of templates" })
  @Roles(...SALON_MANAGERS)
  async getTemplates(@CurrentUser() user: User) {
    return this.campaignsService.getTemplates(user.tenantId);
  }

  @Get("templates/:id")
  @ApiOperation({ summary: "Get template by ID" })
  @ApiResponse({ status: 200, description: "Template details" })
  @Roles(...SALON_MANAGERS)
  async getTemplate(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.getTemplate(user.tenantId, id);
  }

  @Post("templates")
  @ApiOperation({ summary: "Create new template" })
  @ApiResponse({ status: 201, description: "Template created" })
  @Roles(...SALON_MANAGERS)
  async createTemplate(
    @CurrentUser() user: User,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.campaignsService.createTemplate(user.tenantId, dto);
  }

  @Delete("templates/:id")
  @ApiOperation({ summary: "Delete template" })
  @ApiResponse({ status: 200, description: "Template deleted" })
  @Roles(...SALON_MANAGERS)
  async deleteTemplate(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.deleteTemplate(user.tenantId, id);
  }

  // ============ BROADCAST ============

  @Post("broadcast")
  @ApiOperation({ summary: "Broadcast to all clients" })
  @ApiResponse({ status: 201, description: "Broadcast sent" })
  @Roles(...SALON_MANAGERS)
  async broadcast(@CurrentUser() user: User, @Body() dto: SendCampaignDto) {
    return this.campaignsService.broadcastToAllClients(user.tenantId, dto);
  }

  // ============ RE-ENGAGEMENT CAMPAIGNS ============

  @Post("reengagement")
  @ApiOperation({ summary: "Create re-engagement campaign" })
  @ApiResponse({ status: 201, description: "Re-engagement campaign created" })
  @Roles(...SALON_MANAGERS)
  async createReengagementCampaign(
    @CurrentUser() user: User,
    @Body() dto: CreateReengagementCampaignDto,
  ) {
    return this.campaignsService.createReengagementCampaign(user.tenantId, dto);
  }

  @Post(":id/activate")
  @ApiOperation({
    summary: "Activate a campaign (for re-engagement campaigns)",
  })
  @ApiResponse({ status: 200, description: "Campaign activated" })
  @Roles(...SALON_MANAGERS)
  async activateCampaign(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.activateCampaign(user.tenantId, id);
  }

  @Post(":id/deactivate")
  @ApiOperation({ summary: "Deactivate a campaign" })
  @ApiResponse({ status: 200, description: "Campaign deactivated" })
  @Roles(...SALON_MANAGERS)
  async deactivateCampaign(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    return this.campaignsService.deactivateCampaign(user.tenantId, id);
  }

  @Get("promotions/available")
  @ApiOperation({
    summary: "Get available promotions for re-engagement campaigns",
  })
  @ApiResponse({ status: 200, description: "List of active promotions" })
  @Roles(...SALON_MANAGERS)
  async getAvailablePromotions(@CurrentUser() user: User) {
    return this.promotionsService.getAll(user.tenantId);
  }
}
