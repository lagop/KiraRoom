import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { OnboardingService } from "./onboarding.service";
import { SubmitOnboardingWizardDto } from "./dto/onboarding-wizard.dto";
import { Roles, SALON_TEAM, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

@Controller("onboarding")
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("state")
  @Roles(...SALON_TEAM)
  async getState(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.getState(tenantId);
  }

  @Post("step/:key/skip")
  @Roles(...SALON_MANAGERS)
  async skipStep(@Req() req: AuthedRequest, @Param("key") key: string) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.skipStep(tenantId, key);
  }

  @Post("checklist/dismiss")
  @Roles(...SALON_MANAGERS)
  async dismiss(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.dismissChecklist(tenantId);
  }

  @Post("checklist/restore")
  @Roles(...SALON_MANAGERS)
  async restore(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.restoreChecklist(tenantId);
  }

  // ==================== Sprint 2 / 2.1 — owner wizard ====================

  @Get("wizard")
  @Roles(...SALON_MANAGERS)
  async getWizard(@Req() req: AuthedRequest) {
    const tenantId = this.requireTenantId(req);
    return this.onboarding.getWizard(tenantId);
  }

  @Post("wizard")
  @Roles(...SALON_MANAGERS)
  async submitWizard(
    @Req() req: AuthedRequest,
    @Body() body: SubmitOnboardingWizardDto,
  ) {
    const tenantId = this.requireTenantId(req);
    // Only the days sent: the week is stored whole as openingHours.
    const workingHours = body.workingHours
      ? Object.fromEntries(Object.entries(body.workingHours).filter(([, v]) => v !== undefined))
      : undefined;
    return this.onboarding.submitWizard(tenantId, {
      services: body.services?.map((s) => ({
        name: s.name,
        durationMinutes: s.durationMinutes,
        price: s.price,
        description: s.description,
      })),
      firstAppointment: body.firstAppointment && {
        clientName: body.firstAppointment.clientName,
        serviceName: body.firstAppointment.serviceName,
        date: body.firstAppointment.date,
        time: body.firstAppointment.time,
      },
      workingHours,
    });
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) {
      throw new Error("Missing tenantId on authenticated request");
    }
    return t;
  }
}