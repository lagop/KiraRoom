import { ParseUUIDPipe, Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Req, BadRequestException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { PaymentsService } from "./payments.service";
import { SubscriptionsService } from "./services/subscriptions.service";
import { WalletService } from "./services/wallet.service";
import { StripeService } from "./services/stripe.service";
import { ProfessionalsService } from "../professionals/professionals.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  UpdateStripeSettingsDto,
  StripeSettingsResponseDto,
} from "./dto/stripe-settings.dto";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";

@ApiTags("Payments")
@Controller("payments")
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@ApiBearerAuth()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly walletService: WalletService,
    private readonly stripeService: StripeService,
    private readonly professionalsService: ProfessionalsService,
  ) {}

  // ============ PAYMENTS ============

  @Get()
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get all payments for tenant" })
  async getPayments(
    @Req() req: any,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("status") status?: string,
    @Query("clientId") clientId?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder?: "asc" | "desc",
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    // Obtener professionalId para usuarios STAFF
    let professionalId = null;
    if (req.user.role === "staff") {
      const professional =
        await this.professionalsService.getProfessionalByUserId(
          req.user.id,
          req.user.tenantId,
        );
      professionalId = professional?.id;
    }

    return this.paymentsService.getPayments(req.user.tenantId, professionalId, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      status,
      clientId,
      sortBy,
      sortOrder,
      dateFrom,
      dateTo,
    });
  }

  @Get("today")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get today's payments for POS" })
  async getTodayPayments(@Req() req: any) {
    // Obtener professionalId para usuarios STAFF
    let professionalId = null;
    if (req.user.role === "staff") {
      const professional =
        await this.professionalsService.getProfessionalByUserId(
          req.user.id,
          req.user.tenantId,
        );
      professionalId = professional?.id;
    }

    return this.paymentsService.getTodayPayments(
      req.user.tenantId,
      professionalId,
    );
  }

  @Get(":id")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get payment by ID" })
  async getPayment(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.paymentsService.getPaymentById(req.user.tenantId, id);
  }

  @Delete(":id")
  @Roles("owner")
  @ApiOperation({
    summary: "Delete/cancel a payment (Owner only - payments older than 24h)",
  })
  async deletePayment(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    // Validar que el pago tenga más de 24 horas
    const payment = await this.paymentsService.getPaymentById(
      req.user.tenantId,
      id,
    );
    const paymentAge = Date.now() - new Date(payment.createdAt).getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (paymentAge < twentyFourHours) {
      throw new BadRequestException(
        "Only payments older than 24 hours can be deleted",
      );
    }

    return this.paymentsService.deletePayment(req.user.tenantId, id);
  }

  @Post()
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Create a new payment" })
  async createPayment(
    @Req() req: any,
    @Body()
    body: {
      amount: number;
      clientId?: string;
      appointmentId?: string;
      type?: string;
      stripePaymentId?: string;
      isDeposit?: boolean;
      depositAmount?: number;
      remainingAmount?: number;
      description?: string;
      method?:
        | "cash"
        | "card"
        | "bank_transfer"
        | "wallet"
        | "gift_card"
        | "loyalty_points";
    },
  ) {
    // Obtener professionalId para usuarios STAFF
    let professionalId = null;
    if (req.user.role === "staff") {
      const professional =
        await this.professionalsService.getProfessionalByUserId(
          req.user.id,
          req.user.tenantId,
        );
      professionalId = professional?.id;
    }

    return this.paymentsService.createPayment(
      req.user.tenantId,
      professionalId,
      {
        clientId: body.clientId || "",
        appointmentId: body.appointmentId,
        amount: body.amount,
        method: body.method || "cash",
        type: (body.type as any) || "appointment",
        status: "pending",
        description: body.description,
      },
    );
  }

  @Patch(":id/status")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Update payment status" })
  async updatePaymentStatus(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { status: string },
  ) {
    return this.paymentsService.updatePaymentStatus(
      req.user.tenantId,
      id,
      body.status as "pending" | "paid" | "failed" | "refunded",
    );
  }

  @Get("appointment/:appointmentId")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get payments by appointment" })
  async getPaymentsByAppointment(
    @Param("appointmentId") appointmentId: string,
  ) {
    return this.paymentsService.getPaymentsByAppointment(appointmentId);
  }

  @Get("client/:clientId")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get payments by client" })
  async getPaymentsByClient(
    @Req() req: any,
    @Param("clientId") clientId: string,
  ) {
    return this.paymentsService.getPaymentsByClient(
      clientId,
      req.user.tenantId,
    );
  }

  @Get("stats/summary")
  @Roles("owner", "admin")
  @ApiOperation({ summary: "Get payment statistics" })
  async getPaymentStats(
    @Req() req: any,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.paymentsService.getPaymentStats(
      req.user.tenantId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  @Post("confirm/:paymentIntentId")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Confirm payment" })
  async confirmPayment(
    @Req() req: any,
    @Param("paymentIntentId") paymentIntentId: string,
  ) {
    return this.paymentsService.confirmPayment(
      req.user.tenantId,
      paymentIntentId,
    );
  }

  // ============ SUBSCRIPTIONS ============

  @Get("subscription/current")
  @Roles("owner")
  @ApiOperation({ summary: "Get current subscription" })
  async getSubscription(@Req() req: any) {
    return this.subscriptionsService.getSubscription(req.user.tenantId);
  }

  @Post("subscription/checkout")
  @Roles("owner")
  @ApiOperation({ summary: "Create subscription checkout session" })
  async createCheckout(@Req() req: any, @Body() body: { plan: string }) {
    return this.subscriptionsService.createCheckoutSession(
      req.user.tenantId,
      body.plan,
    );
  }

  @Post("subscription/change-plan")
  @Roles("owner")
  @ApiOperation({ summary: "Change subscription plan" })
  async changePlan(@Req() req: any, @Body() body: { plan: string }) {
    return this.subscriptionsService.changePlan(req.user.tenantId, body.plan);
  }

  @Post("subscription/cancel")
  @Roles("owner")
  @ApiOperation({ summary: "Cancel subscription" })
  async cancelSubscription(
    @Req() req: any,
    @Body() body: { immediately?: boolean },
  ) {
    return this.subscriptionsService.cancelSubscription(
      req.user.tenantId,
      body.immediately,
    );
  }

  @Post("subscription/reactivate")
  @Roles("owner")
  @ApiOperation({
    summary:
      "Reactivate a previously cancelled subscription (rev 3 read-only flow)",
  })
  async reactivateSubscription(@Req() req: any) {
    return this.subscriptionsService.reactivateSubscription(req.user.tenantId);
  }

  @Post("subscription/billing-portal")
  @Roles("owner")
  @ApiOperation({ summary: "Open a Stripe Customer Portal session so the tenant owner can manage card, billing address and invoices" })
  async createBillingPortalSession(@Req() req: any) {
    const returnUrl = (process.env.FRONTEND_URL || "http://localhost:3000") + "/dashboard/billing";
    return this.subscriptionsService.createBillingPortalSession(req.user.tenantId, returnUrl);
  }
  @Post("subscription/update-locations")
  @Roles("owner")
  @ApiOperation({
    summary: "Update the number of locations (only valid for plan=empresa)",
  })
  async updateLocationCount(
    @Req() req: any,
    @Body() body: { locationCount: number },
  ) {
    return this.subscriptionsService.updateLocationCount(
      req.user.tenantId,
      body.locationCount,
    );
  }

  @Get("subscription/trial-status")
  @Roles("owner", "admin")
  @ApiOperation({ summary: "Get trial status for the current tenant" })
  async getTrialStatus(@Req() req: any) {
    const sub = await this.subscriptionsService.getSubscription(
      req.user.tenantId,
    );
    const now = Date.now();
    const trialEnd = sub.trialEnd ? new Date(sub.trialEnd).getTime() : null;
    const daysRemaining = trialEnd
      ? Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)))
      : 0;
    return {
      inTrial: sub.status === "trialing" && trialEnd !== null && trialEnd > now,
      daysRemaining,
      trialEnd: sub.trialEnd ?? null,
      subscriptionStatus: sub.status,
    };
  }

  @Get("subscription/invoices")
  @Roles("owner")
  @ApiOperation({ summary: "Get subscription invoices" })
  async getInvoices(@Req() req: any, @Query("limit") limit?: string) {
    return this.subscriptionsService.getInvoices(
      req.user.tenantId,
      limit ? parseInt(limit) : 10,
    );
  }

  @Get("subscription/usage")
  @Roles("owner")
  @ApiOperation({ summary: "Get subscription usage stats" })
  async getUsageStats(@Req() req: any) {
    return this.subscriptionsService.getUsageStats(req.user.tenantId);
  }

  @Get("subscription/plans")
  @Roles("owner")
  @ApiOperation({ summary: "Get available subscription plans (rev 3, no parked features)" })
  async getPlans() {
    return this.subscriptionsService.getPublicPlans();
  }

  // ============ WALLET ============

  @Get("wallet/:clientId")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get client wallet" })
  async getWallet(@Req() req: any, @Param("clientId") clientId: string) {
    return this.walletService.getWallet(req.user.tenantId, clientId);
  }

  @Post("wallet/:clientId/deposit")
  @Roles("owner", "admin")
  @Feature("wallet" as any)
  @ApiOperation({ summary: "Deposit funds to client wallet" })
  async depositWallet(
    @Req() req: any,
    @Param("clientId") clientId: string,
    @Body() body: { amount: number; description?: string },
  ) {
    return this.walletService.addFunds(
      req.user.tenantId,
      clientId,
      body.amount,
      body.description,
    );
  }

  @Post("wallet/:clientId/withdraw")
  @Roles("owner", "admin")
  @Feature("wallet" as any)
  @ApiOperation({ summary: "Withdraw funds from client wallet" })
  async withdrawWallet(
    @Req() req: any,
    @Param("clientId") clientId: string,
    @Body() body: { amount: number; description?: string },
  ) {
    return this.walletService.deductFunds(
      req.user.tenantId,
      clientId,
      body.amount,
      body.description,
    );
  }

  @Get("wallet/:clientId/transactions")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get client wallet transactions" })
  async getWalletTransactions(
    @Req() req: any,
    @Param("clientId") clientId: string,
    @Query("limit") limit?: string,
  ) {
    return this.walletService.getClientTransactions(
      req.user.tenantId,
      clientId,
      limit ? parseInt(limit) : 20,
    );
  }

  @Get("wallet/:clientId/stats")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get client wallet stats" })
  async getWalletStats(@Req() req: any, @Param("clientId") clientId: string) {
    return this.walletService.getWalletStats(req.user.tenantId, clientId);
  }

  @Post("wallet/:clientId/points/earn")
  @Roles("owner", "admin")
  @Feature("loyalty" as any)
  @ApiOperation({ summary: "Award loyalty points to client" })
  async earnPoints(
    @Req() req: any,
    @Param("clientId") clientId: string,
    @Body() body: { points: number; description?: string },
  ) {
    return this.walletService.addLoyaltyPoints(
      req.user.tenantId,
      clientId,
      body.points,
      body.description,
    );
  }

  @Post("wallet/:clientId/points/redeem")
  @Roles("owner", "admin")
  @Feature("loyalty" as any)
  @ApiOperation({ summary: "Redeem loyalty points" })
  async redeemPoints(
    @Req() req: any,
    @Param("clientId") clientId: string,
    @Body() body: { points: number; description?: string },
  ) {
    return this.walletService.redeemLoyaltyPoints(
      req.user.tenantId,
      clientId,
      body.points,
      body.description,
    );
  }

  @Post("appointments/:appointmentId/deposit")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Process appointment deposit payment" })
  async processDeposit(
    @Req() req: any,
    @Param("appointmentId") appointmentId: string,
    @Body() body: { amount: number; method: "card" | "cash" },
  ) {
    const tenantId = req.user.tenantId;
    return this.paymentsService.processDeposit(
      tenantId,
      appointmentId,
      body.amount,
      body.method,
    );
  }

  @Post("appointments/:appointmentId/collect-balance")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Collect remaining balance after deposit" })
  async collectBalance(
    @Req() req: any,
    @Param("appointmentId") appointmentId: string,
    @Body() body: { amount: number; method: "card" | "cash" },
  ) {
    const tenantId = req.user.tenantId;
    return this.paymentsService.collectBalance(
      tenantId,
      appointmentId,
      body.amount,
      body.method,
    );
  }

  // ============ STRIPE SETTINGS ============

  @Get("stripe/settings")
  @Roles("owner", "admin")
  @ApiOperation({ summary: "Get Stripe configuration for tenant" })
  async getStripeSettings(@Req() req: any): Promise<StripeSettingsResponseDto> {
    const tenantId = req.user.tenantId;

    // Use Prisma directly to get tenant settings
    const { PrismaService } = await import("../common/prisma/prisma.service");
    const prisma = new PrismaService();

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        stripeMode: true,
        stripeTestSecretKey: true,
        stripeTestPublishableKey: true,
        stripeLiveSecretKey: true,
        stripeLivePublishableKey: true,
      },
    });

    const isConfigured = !!(
      (tenant?.stripeMode === "test" && tenant?.stripeTestSecretKey) ||
      (tenant?.stripeMode === "live" && tenant?.stripeLiveSecretKey) ||
      (tenant?.stripeMode === undefined && tenant?.stripeTestSecretKey)
    );

    return {
      stripeMode: (tenant?.stripeMode as "test" | "live") || "test",
      stripeTestSecretKey: tenant?.stripeTestSecretKey || null,
      stripeTestPublishableKey: tenant?.stripeTestPublishableKey || null,
      stripeLiveSecretKey: tenant?.stripeLiveSecretKey || null,
      stripeLivePublishableKey: tenant?.stripeLivePublishableKey || null,
      isConfigured,
    };
  }

  @Patch("stripe/settings")
  @Roles("owner", "admin")
  @ApiOperation({ summary: "Update Stripe configuration for tenant" })
  async updateStripeSettings(
    @Req() req: any,
    @Body() dto: UpdateStripeSettingsDto,
  ) {
    const tenantId = req.user.tenantId;

    const { PrismaService } = await import("../common/prisma/prisma.service");
    const prisma = new PrismaService();

    const updateData: any = {};

    if (dto.stripeMode !== undefined) {
      updateData.stripeMode = dto.stripeMode;
    }
    if (dto.stripeTestSecretKey !== undefined) {
      updateData.stripeTestSecretKey = dto.stripeTestSecretKey || null;
    }
    if (dto.stripeTestPublishableKey !== undefined) {
      updateData.stripeTestPublishableKey =
        dto.stripeTestPublishableKey || null;
    }
    if (dto.stripeLiveSecretKey !== undefined) {
      updateData.stripeLiveSecretKey = dto.stripeLiveSecretKey || null;
    }
    if (dto.stripeLivePublishableKey !== undefined) {
      updateData.stripeLivePublishableKey =
        dto.stripeLivePublishableKey || null;
    }

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: updateData,
    });

    // Clear cache so new settings take effect immediately
    this.stripeService.clearTenantCache(tenantId);

    return {
      success: true,
      stripeMode: updated.stripeMode,
    };
  }

  @Get("stripe/publishable-key")
  @Roles("owner", "admin", "staff")
  @ApiOperation({ summary: "Get Stripe publishable key for frontend" })
  async getStripePublishableKey(@Req() req: any) {
    const tenantId = req.user.tenantId;
    const publishableKey =
      await this.stripeService.getPublishableKeyForTenant(tenantId);
    return { publishableKey };
  }
}
