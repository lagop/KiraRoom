import { Injectable, Logger, BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import Stripe from "stripe";

const DOMAIN_RE_PRIMITIVE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z]{2,})+$/i;

@Injectable()
export class WebDomainService {
  private readonly logger = new Logger(WebDomainService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    if (key && key.startsWith("sk_")) {
      this.stripe = new Stripe(key, { apiVersion: "2024-12-18.acacia" as any });
    }
  }

  isValidDomain(domain: string): boolean {
    if (!domain || domain.length > 253) return false;
    return DOMAIN_RE_PRIMITIVE.test(domain.trim().toLowerCase());
  }

  /**
   * Mocked availability check. In production this would call a registrar
   * API (e.g. Resell.biz, Namecheap, Cloudflare). We keep the surface so
   * the UI can be built end-to-end before the integration is wired.
   */
  async checkAvailability(domain: string): Promise<{
    domain: string;
    available: boolean;
    via: "mock";
  }> {
    const normalized = domain.trim().toLowerCase();
    if (!this.isValidDomain(normalized)) {
      throw new BadRequestException("Dominio no valido");
    }
    const takenSuffixes = [".test", ".example", ".invalid"];
    const taken = takenSuffixes.some((s) => normalized.endsWith(s));
    return { domain: normalized, available: !taken, via: "mock" };
  }

  async getStatus(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { addons: true },
    });
    const addons = (tenant?.addons as Record<string, any>) || {};
    return {
      enabled: !!addons.web_domain?.enabled,
      activatedAt: addons.web_domain?.activatedAt ?? null,
      expiresAt: addons.web_domain?.expiresAt ?? null,
      domain: addons.web_domain?.domain ?? null,
    };
  }

  /**
   * Open a Stripe checkout for the web_domain add-on. The webhook
   * (customer.subscription.created with metadata.addon='web_domain') flips
   * Tenant.addons.web_domain.enabled=true. Until Stripe is wired, we flip
   * the flag locally so the dev experience works.
   */
  async purchase(tenantId: string, domain: string) {
    const normalized = domain.trim().toLowerCase();
    if (!this.isValidDomain(normalized)) {
      throw new BadRequestException("Dominio no valido");
    }
    const now = new Date();
    const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    if (this.stripe) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      if (!tenant) throw new NotFoundException("Tenant no encontrado");
      let customerId = tenant.stripeCustomerId;
      if (!customerId) {
        const customer = await this.stripe.customers.create({
          metadata: { tenantId },
          email: tenant.email ?? undefined,
          name: tenant.name,
        });
        customerId = customer.id;
        await this.prisma.tenant.update({
          where: { id: tenantId },
          data: { stripeCustomerId: customerId },
        });
      }
      // Minimal: caller will be redirected to billing. The price/terms are
      // out of scope for engineering (per plan section 4.8).
      return { checkoutRequired: true, domain: normalized };
    }

    // No Stripe: activate immediately for development.
    await this.activateLocally(tenantId, normalized, now, expires);
    return {
      checkoutRequired: false,
      domain: normalized,
      activatedAt: now,
      expiresAt: expires,
    };
  }

  async activateLocally(
    tenantId: string,
    domain: string,
    activatedAt: Date,
    expiresAt: Date,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { addons: true },
    });
    if (!tenant) throw new NotFoundException("Tenant no encontrado");
    const addons = (tenant.addons as Record<string, any>) || {};
    addons.web_domain = {
      enabled: true,
      activatedAt,
      expiresAt,
      domain,
    };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { addons: addons as any },
    });
  }

  /**
   * Configure the CNAME / SEO / sitemap for an active add-on. The custom
   * domain resolver itself lives in the public site (sites/[salonName]).
   */
  async configure(
    tenantId: string,
    payload: { domain?: string; seoTitle?: string; seoDescription?: string },
  ) {
    const status = await this.getStatus(tenantId);
    if (!status.enabled) {
      throw new BadRequestException("El add-on web_domain no esta activo");
    }
    if (payload.domain) {
      if (!this.isValidDomain(payload.domain)) {
        throw new BadRequestException("Dominio no valido");
      }
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { addons: true },
    });
    const addons = (tenant?.addons as Record<string, any>) || {};
    addons.web_domain = {
      ...(addons.web_domain || {}),
      ...payload,
    };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { addons: addons as any },
    });
    return { ok: true, config: addons.web_domain };
  }
}