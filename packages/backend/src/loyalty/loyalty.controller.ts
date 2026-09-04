import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import {
  LoyaltyService,
  CreateLoyaltyProgramDto,
  CreateLoyaltyTierDto,
  CreateLoyaltyRewardDto,
} from "./loyalty.service";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

@Controller("loyalty")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Feature("loyalty")
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  // Programs
  @Post("programs")
  @Roles(UserRole.owner, UserRole.admin)
  async createProgram(@Body() dto: CreateLoyaltyProgramDto) {
    return this.loyaltyService.createProgram(dto);
  }

  @Get("programs/:tenantId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getPrograms(@Param("tenantId") tenantId: string) {
    return this.loyaltyService.getPrograms(tenantId);
  }

  @Get("programs/detail/:id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getProgram(@Param("id") id: string) {
    return this.loyaltyService.getProgram(id);
  }

  @Put("programs/:id")
  @Roles(UserRole.owner, UserRole.admin)
  async updateProgram(
    @Param("id") id: string,
    @Body() dto: Partial<CreateLoyaltyProgramDto>,
  ) {
    return this.loyaltyService.updateProgram(id, dto);
  }

  @Delete("programs/:id")
  @Roles(UserRole.owner, UserRole.admin)
  async deleteProgram(@Param("id") id: string) {
    return this.loyaltyService.deleteProgram(id);
  }

  // Tiers
  @Post("tiers")
  @Roles(UserRole.owner, UserRole.admin)
  async createTier(@Body() dto: CreateLoyaltyTierDto) {
    return this.loyaltyService.createTier(dto);
  }

  @Delete("tiers/:id")
  @Roles(UserRole.owner, UserRole.admin)
  async deleteTier(@Param("id") id: string) {
    return this.loyaltyService.deleteTier(id);
  }

  // Rewards
  @Post("rewards")
  @Roles(UserRole.owner, UserRole.admin)
  async createReward(@Body() dto: CreateLoyaltyRewardDto) {
    return this.loyaltyService.createReward(dto);
  }

  @Get("rewards/:programId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getRewards(@Param("programId") programId: string) {
    return this.loyaltyService.getRewards(programId);
  }

  @Put("rewards/:id")
  @Roles(UserRole.owner, UserRole.admin)
  async updateReward(
    @Param("id") id: string,
    @Body() dto: Partial<CreateLoyaltyRewardDto>,
  ) {
    return this.loyaltyService.updateReward(id, dto);
  }

  @Delete("rewards/:id")
  @Roles(UserRole.owner, UserRole.admin)
  async deleteReward(@Param("id") id: string) {
    return this.loyaltyService.deleteReward(id);
  }

  // Members
  @Post("members")
  @Roles(UserRole.owner, UserRole.admin)
  async addMember(@Body() dto: { clientId: string; programId: string }) {
    return this.loyaltyService.addMember(dto.clientId, dto.programId);
  }

  @Get("members/:programId")
  @Roles(UserRole.owner, UserRole.admin)
  async getMembers(@Param("programId") programId: string) {
    return this.loyaltyService.getMembers(programId);
  }

  @Get("client/:clientId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getClientLoyalty(@Param("clientId") clientId: string) {
    return this.loyaltyService.getClientLoyalty(clientId);
  }

  // Points
  @Post("points/award")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async awardPoints(
    @Body() dto: { memberId: string; points: number; description: string },
  ) {
    return this.loyaltyService.awardPoints(
      dto.memberId,
      dto.points,
      dto.description,
    );
  }

  @Post("points/redeem")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async redeemPoints(
    @Body() dto: { memberId: string; points: number; rewardId: string },
  ) {
    return this.loyaltyService.redeemPoints(
      dto.memberId,
      dto.points,
      dto.rewardId,
    );
  }

  @Get("points/:clientId/:programId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getClientPoints(
    @Param("clientId") clientId: string,
    @Param("programId") programId: string,
  ) {
    return this.loyaltyService.getClientPoints(clientId, programId);
  }
}
