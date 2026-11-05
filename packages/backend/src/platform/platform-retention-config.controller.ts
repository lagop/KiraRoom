import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlatformRetentionConfigPublic, PlatformRetentionConfigService } from "./platform-retention-config.service";
import { UpdatePlatformRetentionConfigDto } from "./platform-retention-config.dto";

interface AuthedRequest {
  user: { id: string; role: string };
}

/** The retention job's switch (on / dry run), for the saas_owner only. */
@ApiTags("platform-retention-config")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("platform/retention-config")
export class PlatformRetentionConfigController {
  constructor(private readonly service: PlatformRetentionConfigService) {}

  @Get()
  @Roles("saas_owner")
  get(): Promise<PlatformRetentionConfigPublic> {
    return this.service.getConfig();
  }

  @Put()
  @Roles("saas_owner")
  update(@Req() req: AuthedRequest, @Body() body: UpdatePlatformRetentionConfigDto): Promise<PlatformRetentionConfigPublic> {
    return this.service.update({ enabled: body.enabled }, { id: req.user.id, role: req.user.role });
  }
}
