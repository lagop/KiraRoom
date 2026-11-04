import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "../guards/saas-owner.guard";
import { SaasOwner } from "../decorators/saas-owner.decorator";
import { WeeklyDigest, WeeklyDigestService } from "./weekly-digest.service";

@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/weekly")
export class WeeklyDigestController {
  constructor(private readonly digest: WeeklyDigestService) {}

  @Get()
  @ApiOperation({ summary: "What needs the platform owner this week (SaaS Owner only)" })
  get(): Promise<WeeklyDigest> {
    return this.digest.build(new Date());
  }
}
