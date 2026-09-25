import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { runUnscoped } from "../tenancy/tenant.context";

export interface LlmUsageSample {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/** `YYYY-MM` in UTC, the billing period key. */
export function usagePeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Accumulates LLM token consumption per tenant, month, provider and model.
 *
 * Providers always reported these numbers and nothing persisted them, so
 * cost could not be attributed to a tenant and the margin per plan was
 * guesswork. Recording is fire-and-forget: a usage write must never fail
 * the conversation it is measuring.
 */
@Injectable()
export class LlmUsageService {
  private readonly logger = new Logger(LlmUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  record(sample: LlmUsageSample): void {
    void this.recordAsync(sample).catch((err: Error) => {
      this.logger.warn(`LLM usage not recorded: ${err.message}`);
    });
  }

  private async recordAsync(sample: LlmUsageSample): Promise<void> {
    const period = usagePeriod();
    const input = BigInt(Math.max(0, Math.round(sample.inputTokens || 0)));
    const output = BigInt(Math.max(0, Math.round(sample.outputTokens || 0)));
    const cached = BigInt(Math.max(0, Math.round(sample.cachedInputTokens || 0)));
    const written = BigInt(Math.max(0, Math.round(sample.cacheWriteTokens || 0)));

    // Atomic increments so concurrent LLM calls for the same tenant cannot
    // lose a sample to a read-modify-write race.
    await runUnscoped(() =>
      this.prisma.tenantLlmUsage.upsert({
        where: {
          tenantId_period_provider_model: {
            tenantId: sample.tenantId,
            period,
            provider: sample.provider,
            model: sample.model,
          },
        },
        create: {
          tenantId: sample.tenantId,
          period,
          provider: sample.provider,
          model: sample.model,
          calls: 1,
          inputTokens: input,
          outputTokens: output,
          cachedInputTokens: cached,
          cacheWriteTokens: written,
        },
        update: {
          calls: { increment: 1 },
          inputTokens: { increment: input },
          outputTokens: { increment: output },
          cachedInputTokens: { increment: cached },
          cacheWriteTokens: { increment: written },
        },
      }),
    );
  }

  /** Usage for one tenant in a period, for the SaaS console and support. */
  async forTenant(tenantId: string, period = usagePeriod()) {
    return runUnscoped(() =>
      this.prisma.tenantLlmUsage.findMany({
        where: { tenantId, period },
        orderBy: [{ provider: "asc" }, { model: "asc" }],
      }),
    );
  }

  /**
   * Heaviest tenants in a period, by output tokens -- the most expensive
   * side of the bill on every current model. For spotting a runaway before
   * the invoice does.
   */
  async topConsumers(period = usagePeriod(), limit = 20) {
    return runUnscoped(() =>
      this.prisma.tenantLlmUsage.findMany({
        where: { period },
        orderBy: { outputTokens: "desc" },
        take: limit,
      }),
    );
  }
}
