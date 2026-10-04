import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { LoyaltyService } from "./loyalty.service";
import {
  AdjustPointsDto,
  EnrollMemberDto,
  LoyaltyProgramSettingsDto,
  LoyaltyRewardDto,
  LoyaltyTierDto,
  UpdateLoyaltyRewardDto,
} from "./loyalty.dto";

/**
 * The salon's side of the loyalty programme. The tenant always comes from
 * the session: these routes used to take it, and any program or member id,
 * from the URL.
 */
@Controller("loyalty")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("loyalty")
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get("program")
  @Roles(...SALON_TEAM)
  async getProgram(@Req() req: any) {
    return { program: await this.loyalty.getProgram(req.user.tenantId) };
  }

  @Put("program")
  @Roles(...SALON_MANAGERS)
  async saveProgram(@Req() req: any, @Body() dto: LoyaltyProgramSettingsDto) {
    return { program: await this.loyalty.saveProgram(req.user.tenantId, dto) };
  }

  @Post("rewards")
  @Roles(...SALON_MANAGERS)
  createReward(@Req() req: any, @Body() dto: LoyaltyRewardDto) {
    return this.loyalty.createReward(req.user.tenantId, dto);
  }

  @Put("rewards/:id")
  @Roles(...SALON_MANAGERS)
  updateReward(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoyaltyRewardDto,
  ) {
    return this.loyalty.updateReward(req.user.tenantId, id, dto);
  }

  @Delete("rewards/:id")
  @Roles(...SALON_MANAGERS)
  deleteReward(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.loyalty.deleteReward(req.user.tenantId, id);
  }

  @Post("tiers")
  @Roles(...SALON_MANAGERS)
  createTier(@Req() req: any, @Body() dto: LoyaltyTierDto) {
    return this.loyalty.createTier(req.user.tenantId, dto);
  }

  @Delete("tiers/:id")
  @Roles(...SALON_MANAGERS)
  deleteTier(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.loyalty.deleteTier(req.user.tenantId, id);
  }

  @Get("members")
  @Roles(...SALON_TEAM)
  listMembers(@Req() req: any, @Query("search") search?: string) {
    return this.loyalty.listMembers(req.user.tenantId, search);
  }

  /** Signing a client up at the desk or from their file. */
  @Post("members")
  @Roles(...SALON_TEAM)
  enroll(@Req() req: any, @Body() dto: EnrollMemberDto) {
    return this.loyalty.enroll(req.user.tenantId, dto.clientId, "staff", req.user.id);
  }

  @Post("members/:id/adjust")
  @Roles(...SALON_MANAGERS)
  adjust(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AdjustPointsDto,
  ) {
    return this.loyalty.adjust(req.user.tenantId, id, dto, req.user.id);
  }

  /** The client's balance, rewards and history: client file and till. */
  @Get("clients/:clientId")
  @Roles(...SALON_TEAM)
  clientSummary(@Req() req: any, @Param("clientId", ParseUUIDPipe) clientId: string) {
    return this.loyalty.clientSummary(req.user.tenantId, clientId);
  }
}

/**
 * The client's side, from the client portal. Not behind @Feature: a salon
 * without the programme answers { enabled: false } instead of a 403 the
 * portal would have to interpret.
 */
@Controller("loyalty/me")
@UseGuards(JwtAuthGuard, RolesGuard)
export class LoyaltyPortalController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get()
  @Roles(UserRole.client)
  mine(@Req() req: any) {
    return this.loyalty.portalView(req.user.tenantId, req.user.id);
  }

  @Post("join")
  @Roles(UserRole.client)
  join(@Req() req: any) {
    return this.loyalty.portalJoin(req.user.tenantId, req.user.id);
  }
}
