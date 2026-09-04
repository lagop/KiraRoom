import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { OnboardingService } from "./onboarding.service";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("state")
  async getState(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.getState(tenantId);
  }

  @Post("step/:key/skip")
  async skipStep(@Req() req: AuthedRequest, @Param("key") key: string) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.skipStep(tenantId, key);
  }

  @Post("checklist/dismiss")
  async dismiss(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.dismissChecklist(tenantId);
  }

  @Post("checklist/restore")
  async restore(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.restoreChecklist(tenantId);
  }

  // ==================== Sprint 2 / 2.1 — owner wizard ====================

  @Get("wizard")
  async getWizard(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.getWizard(tenantId);
  }

  @Post("wizard")
  async submitWizard(
    @Req() req: AuthedRequest,
    @Body() body: {
      services?: Array<{
        name: string;
        durationMinutes: number;
        price: number;
        description?: string;
      }>;
      firstAppointment?: {
        clientName: string;
        serviceName: string;
        date: string;
        time: string;
      };
      workingHours?: Record<string, { open: string; close: string } | null>;
    },
  ) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.submitWizard(tenantId, body);
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) {
      throw new Error("Missing tenantId on authenticated request");
    }
    return t;
  }
}