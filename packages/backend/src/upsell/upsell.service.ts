import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';

export interface UpsellSuggestion {
  serviceId: string;
  serviceName: string;
  duration: number;
  price: number;
  currency: string;
  reason: string;
  score: number;
}

/**
 * P2A-receptionist-advanced â€” service upsell. When the AI receptionist
 * detects a "what else do you offer?" / "what do you recommend?" kind
 * of intent (or simply when the user has finished booking), the
 * orchestrator asks this service for a curated list of services the
 * tenant wants to push, ranked by what fits the client best.
 *
 * Today the "ranking" is naive: services in the same category rank
 * higher (so a haircut client gets other hair services first), then
 * by recency + price. Phase v2 follow-up will plug the AI LLM in for
 * the scoring â€” the data shape is already compatible.
 */
@Injectable()
export class UpsellService {
  private readonly logger = new Logger(UpsellService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
  ) {}

  async suggest(tenantId: string, ctx: { clientId?: string; excludeServiceIds?: string[] } = {}): Promise<UpsellSuggestion[]> {
    if (!(await this.flags.isFeatureUnlocked(tenantId, 'virtual_receptionist_advanced'))) {
      return [];
    }

    // Fetch the latest appointment for this client (if any) so we
    // can boost same-category services. Note: Appointment stores a
    // single `serviceId` (not a services[] relation) and Service's
    // `category` is an enum (not a relation).
    let lastCategory: string | null = null;
    if (ctx.clientId) {
      const last = await this.prisma.appointment.findFirst({
        where: { tenantId, clientId: ctx.clientId, status: { not: 'cancelled' } },
        orderBy: { scheduledDate: 'desc' },
        select: { service: { select: { category: true } } },
      });
      lastCategory = (last as any)?.service?.category ?? null;
    }

    const services = await this.prisma.service.findMany({
      where: {
        tenantId,
        isActive: true,
        ...(ctx.excludeServiceIds?.length
          ? { id: { notIn: ctx.excludeServiceIds } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    return services.map((s) => {
      const score = s.category === lastCategory ? 1.0 : 0.5;
      const reason =
        s.category === lastCategory
          ? `Matches your previous visit (${String(s.category).toLowerCase()})`
          : 'Other service this salon offers';
      return {
        serviceId: s.id,
        serviceName: s.name,
        duration: s.duration,
        price: Number(s.price),
        currency: 'EUR',
        reason,
        score,
      };
    });
  }
}
