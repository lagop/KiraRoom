import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { AddOnsService } from '../payments/services/addons.service';
import { MetricsService, COUNTERS } from '../common/observability/metrics.service';
import Stripe from 'stripe';

export type CreditChannel = 'whatsapp_marketing' | 'sms_marketing';

export interface ConsumeCreditResult {
  /** True if the credit was consumed; false if the tenant was over quota. */
  ok: boolean;
  /** Remaining credits after this attempt (or current, if rejected). */
  remaining: number;
  /** Stripe `usage_record` id, when the metered usage was reported. */
  usageRecordId?: string;
  reason?: 'no_addon' | 'no_wallet' | 'no_credits';
}

/**
 * P2A-receptionist-v2 â€” `message_bundles` metered add-on.
 *
 * Flow per the Phase v2 spec:
 *   1. Tenant buys a top-up of N credits via Stripe (recurring or
 *      one-shot). Webhook handler calls `creditTopUp()`.
 *   2. Tenant sends a marketing message (WhatsApp campaign or
 *      SMS marketing). Caller invokes `consumeCredit()` BEFORE the
 *      send. If the wallet is empty, the caller is expected to
 *      short-circuit and surface a "you've run out of credits" UX.
 *   3. After a successful send we report `usageRecords.create({ quantity: 1 })`
 *      to Stripe so the metered invoice reflects the real usage.
 *
 * Utility sends (appointment reminders, confirmations) are NOT metered
 * â€” they remain free as per the spec.
 */
@Injectable()
export class MessageBundlesService implements OnModuleInit {
  private readonly logger = new Logger(MessageBundlesService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly addons: AddOnsService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (key && key.startsWith('sk_')) {
      this.stripe = new Stripe(key, {
        apiVersion: '2024-12-18.acacia' as any,
      });
    }
  }

  /**
   * Read the current balance for a tenant. Auto-creates the wallet
   * at 0 credits if missing.
   */
  async getBalance(tenantId: string): Promise<{
    creditsRemaining: number;
    creditsPurchasedTotal: number;
    creditsUsedTotal: number;
    lastTopupAt: Date | null;
  }> {
    let row = await this.prisma.messageCreditWallet.findUnique({
      where: { tenantId },
    });
    if (!row) {
      row = await this.prisma.messageCreditWallet.create({
        data: { tenantId },
      });
    }
    return {
      creditsRemaining: row.creditsRemaining,
      creditsPurchasedTotal: row.creditsPurchasedTotal,
      creditsUsedTotal: row.creditsUsedTotal,
      lastTopupAt: row.lastTopupAt,
    };
  }

  /**
   * Add credits to the wallet. Called by the Stripe webhook for
   * `invoice.payment_succeeded` of a metered product, or by the
   * SaaS-admin manual grant endpoint.
   */
  async creditTopUp(args: {
    tenantId: string;
    credits: number;
    source: 'stripe' | 'manual';
    stripeInvoiceId?: string | null;
  }): Promise<{ newBalance: number }> {
    if (args.credits <= 0) {
      throw new Error('credits must be > 0');
    }
    const updated = await this.prisma.messageCreditWallet.upsert({
      where: { tenantId: args.tenantId },
      create: {
        tenantId: args.tenantId,
        creditsRemaining: args.credits,
        creditsPurchasedTotal: args.credits,
        lastTopupAt: new Date(),
      },
      update: {
        creditsRemaining: { increment: args.credits },
        creditsPurchasedTotal: { increment: args.credits },
        lastTopupAt: new Date(),
      },
    });
    this.logger.log(
      `message-bundles topup tenant=${args.tenantId} +${args.credits} (source=${args.source}, newBalance=${updated.creditsRemaining})`,
    );
    return { newBalance: updated.creditsRemaining };
  }

  /**
   * Consume one credit for a marketing send. Atomic decrement with
   * the rejected-zero guard so a tenant can't go negative. Returns a
   * structured result so the caller can decide between "send anyway
   * in UI" and "skip with error".
   *
   * Does NOT fail the tenant on missing add-on or zero wallet â€” it
   * returns a discriminated union so the marketing pipeline can
   * still proceed in dev / pre-production.
   */
  async consumeCredit(args: {
    tenantId: string;
    channel: CreditChannel;
    /** Stripe `subscription_item` id of the metered add-on, for
     *  the per-line `usageRecord` report. */
    stripeSubscriptionItemId?: string | null;
  }): Promise<ConsumeCreditResult> {
    // Gate: tenant must have the message_bundles add-on active.
    const active = (await this.addons.activeAddOnsForTenant(args.tenantId))
      .includes('message_bundles');
    if (!active) {
      this.metrics
        .counter(COUNTERS.MESSAGE_BUNDLE_CONSUMED, 'Message-bundle credit consumption (per channel × result)')
        .inc({ channel: args.channel, result: 'no_addon' });
      return { ok: false, remaining: 0, reason: 'no_addon' };
    }

    // Atomic decrement. SQL: UPDATE ... SET credits_remaining = credits_remaining - 1
    // WHERE tenantId = $1 AND credits_remaining > 0
    // The WHERE > 0 guard means a tenant can't go negative under
    // concurrent senders; instead the second concurrent sender sees
    // 0 rows updated and gets rejected.
    const result = await this.prisma.$executeRaw`
      UPDATE "message_credit_wallet"
      SET "creditsRemaining" = "creditsRemaining" - 1,
          "creditsUsedTotal" = "creditsUsedTotal" + 1,
          "updatedAt" = NOW()
      WHERE "tenantId" = ${args.tenantId}::text
        AND "creditsRemaining" > 0
      RETURNING "creditsRemaining"
    `;
    if (!result || (Array.isArray(result) && result.length === 0)) {
      this.metrics
        .counter(COUNTERS.MESSAGE_BUNDLE_CONSUMED, 'Message-bundle credit consumption (per channel × result)')
        .inc({ channel: args.channel, result: 'no_credits' });
      return { ok: false, remaining: 0, reason: 'no_credits' };
    }
    const remaining = Number(
      (result[0] as { creditsRemaining: number | string }).creditsRemaining,
    );

    // M-1: bump the per-channel Prometheus counter on every successful
    // consume. Operators can graph consumption by channel/result and
    // alert when the no_credits rate climbs.
    this.metrics
      .counter(COUNTERS.MESSAGE_BUNDLE_CONSUMED, 'Message-bundle credit consumption (per channel × result)')
      .inc({ channel: args.channel, result: 'ok' });

    // Stripe metered usage report. We only call Stripe when:
    //  - the SDK is configured (sk_...)
    //  - the tenant has a real subscription_item id (i.e. was
    //    provisioned by Stripe, not a manual SaaS-admin grant)
    // For manual grants the wallet is decremented but the Stripe
    // invoice isn't affected -- the SaaS-admin decides how to bill.
    if (this.stripe && args.stripeSubscriptionItemId) {
      try {
        const res = await this.stripe.subscriptionItems.createUsageRecord(
          args.stripeSubscriptionItemId,
          {
            quantity: 1,
            timestamp: Math.floor(Date.now() / 1000),
            action: 'increment',
          },
        );
        return { ok: true, remaining, usageRecordId: res.id };
      } catch (err) {
        this.logger.warn(
          `Stripe usage_record failed for tenant=${args.tenantId} (credit already consumed): ${(err as Error).message}`,
        );
        return { ok: true, remaining, usageRecordId: undefined };
      }
    }
    return { ok: true, remaining };
  }
}
