import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import {
  DnsLookup,
  checkDomainDns,
  isPlatformDomain,
  normalizeDomain,
  txtRecordName,
  txtRecordValue,
} from "./custom-domain";
import { normaliseSubdomainBase, salonSubdomainHost } from "@kira/shared";
import { traefikDynamicConfig } from "./traefik-provider";

export interface DnsRecordInstruction {
  type: "CNAME" | "A" | "TXT";
  name: string;
  value: string;
}

export interface WebDomainStatus {
  /**
   * The salon's public page: its free subdomain once those are served over
   * HTTPS, otherwise the page on the platform host. Always works.
   */
  publicUrl: string;
  /**
   * The free address every salon gets (salon-lucia.kiraroom.net). null when
   * subdomains are not configured or the slug cannot be one; active only
   * once the wildcard certificate is in place (SALON_SUBDOMAINS_READY).
   */
  subdomain: null | { host: string; active: boolean };
  /** Host a salon's domain must point at. */
  target: string;
  /**
   * Whether the platform serves custom domains over HTTPS yet. False until
   * the operator sets up certificates for arbitrary hosts (see
   * docs/custom-domains.md) and sets CUSTOM_DOMAINS_TLS_READY=1.
   */
  servingEnabled: boolean;
  domain: null | {
    name: string;
    verified: boolean;
    verifiedAt: Date | null;
    lastCheckedAt: Date | null;
    lastCheckError: string | null;
    /** Verified AND the platform can serve it: the page answers there. */
    active: boolean;
    records: DnsRecordInstruction[];
    /** For a root domain (no CNAME possible): A records to these addresses. */
    targetIps: string[];
  };
}

/**
 * A salon's own domain for its public page.
 *
 * This module used to simulate a domain shop: "check availability" decided
 * by suffix (.test was taken, anything else free), and "purchase" switched a
 * flag on with no registrar, no payment and no DNS. Nothing ever served a
 * salon's page on any domain.
 *
 * Now the salon brings a domain it already owns. We tell it which two DNS
 * records to create, check them with real lookups, and once both are right
 * the frontend's middleware serves the salon's page for that Host. We do not
 * sell or register domains.
 *
 * The one piece that is not code: HTTPS for arbitrary hosts. Traefik only
 * has certificates for the hosts in its labels; see docs/custom-domains.md.
 * Until the operator sets that up and flips CUSTOM_DOMAINS_TLS_READY, a
 * verified domain is reported as verified but not active.
 */
/** How long the verified-domain list behind CORS is reused. */
const VERIFIED_HOSTS_TTL_MS = 60_000;

@Injectable()
export class WebDomainService {
  private readonly logger = new Logger(WebDomainService.name);
  private verifiedHosts: { hosts: Set<string>; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly dns: DnsLookup,
  ) {}

  /** Public base URL of the app, without trailing slash. */
  appBaseUrl(): string {
    const base =
      this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL") ||
      "https://app.kiraroom.net";
    return base.replace(/\/+$/, "");
  }

  /**
   * Where salons point their domain. Defaults to the app's own host, which
   * already resolves to the VPS; CUSTOM_DOMAIN_TARGET lets the operator use
   * a dedicated name (e.g. sites.kiraroom.net) for the TLS front.
   */
  target(): string {
    const explicit = this.config.get<string>("CUSTOM_DOMAIN_TARGET");
    if (explicit && explicit.trim()) return explicit.trim().toLowerCase().replace(/\.$/, "");
    try {
      return new URL(this.appBaseUrl()).hostname;
    } catch {
      return "app.kiraroom.net";
    }
  }

  /** "kiraroom.net" when salons get <slug>.kiraroom.net; "" when not configured. */
  subdomainBase(): string {
    return normaliseSubdomainBase(this.config.get<string>("SALON_SUBDOMAIN_BASE"));
  }

  /** Whether the wildcard certificate is in place and subdomains are live. */
  subdomainsReady(): boolean {
    const raw = (this.config.get<string>("SALON_SUBDOMAINS_READY") ?? "").trim().toLowerCase();
    return (raw === "1" || raw === "true") && !!this.subdomainBase();
  }

  /** The salon's subdomain, only when it actually serves the page. */
  liveSubdomain(slug: string): string | null {
    return this.subdomainsReady() ? salonSubdomainHost(slug, this.subdomainBase()) : null;
  }

  /**
   * Traefik's dynamic configuration (see traefik-provider.ts): a router per
   * verified domain of a live salon, plus the wildcard router for salons'
   * subdomains once a DNS-challenge resolver is configured.
   */
  async traefikConfig() {
    const rows = await runUnscoped(() =>
      this.prisma.customDomain.findMany({
        where: { verifiedAt: { not: null }, tenant: { deletedAt: null } },
        select: { domain: true },
      }),
    );
    const major = Number(this.config.get<string>("TRAEFIK_MAJOR_VERSION") ?? "3");
    return traefikDynamicConfig(
      rows.map((r) => r.domain),
      {
        service: this.config.get<string>("TRAEFIK_FRONTEND_SERVICE") || "kiraroom-app@docker",
        entryPoint: this.config.get<string>("TRAEFIK_ENTRYPOINT_HTTPS") || "websecure",
        certResolver: this.config.get<string>("TRAEFIK_CERTRESOLVER") || "mytlschallenge",
        dnsCertResolver: (this.config.get<string>("TRAEFIK_DNS_CERTRESOLVER") ?? "").trim(),
        subdomainBase: this.subdomainBase(),
        traefikMajor: Number.isFinite(major) && major > 0 ? major : 3,
      },
    );
  }

  /**
   * Whether `host` is a verified domain of a live salon, for CORS: the
   * salon's page on its own domain calls the API from the browser. Cached
   * for a minute, since every preflight from an unknown origin asks.
   */
  async isVerifiedDomain(host: string): Promise<boolean> {
    const now = Date.now();
    if (!this.verifiedHosts || now - this.verifiedHosts.at > VERIFIED_HOSTS_TTL_MS) {
      const rows = await runUnscoped(() =>
        this.prisma.customDomain.findMany({
          where: { verifiedAt: { not: null }, tenant: { deletedAt: null } },
          select: { domain: true },
        }),
      );
      this.verifiedHosts = { hosts: new Set(rows.map((r) => r.domain.toLowerCase())), at: now };
    }
    return this.verifiedHosts.hosts.has(host.toLowerCase());
  }

  servingEnabled(): boolean {
    const raw = (this.config.get<string>("CUSTOM_DOMAINS_TLS_READY") ?? "").trim().toLowerCase();
    return raw === "1" || raw === "true";
  }

  async getStatus(tenantId: string): Promise<WebDomainStatus> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    if (!tenant) throw new NotFoundException("Salón no encontrado");
    const row = await this.prisma.customDomain.findFirst({ where: { tenantId } });
    const target = this.target();
    const servingEnabled = this.servingEnabled();

    let domain: WebDomainStatus["domain"] = null;
    if (row) {
      const targetIps = await this.dns.resolve4(target).catch(() => [] as string[]);
      domain = {
        name: row.domain,
        verified: row.verifiedAt !== null,
        verifiedAt: row.verifiedAt,
        lastCheckedAt: row.lastCheckedAt,
        lastCheckError: row.lastCheckError,
        active: row.verifiedAt !== null && servingEnabled,
        records: [
          { type: "CNAME", name: row.domain, value: target },
          { type: "TXT", name: txtRecordName(row.domain), value: txtRecordValue(row.verificationToken) },
        ],
        targetIps,
      };
    }

    const subdomainHost = salonSubdomainHost(tenant.slug, this.subdomainBase());
    const subdomainActive = !!subdomainHost && this.subdomainsReady();
    return {
      publicUrl: subdomainActive
        ? `https://${subdomainHost}`
        : `${this.appBaseUrl()}/sites/${encodeURIComponent(tenant.slug)}`,
      subdomain: subdomainHost ? { host: subdomainHost, active: subdomainActive } : null,
      target,
      servingEnabled,
      domain,
    };
  }

  /**
   * Record the domain the salon wants and hand out a fresh ownership token.
   * Saving the same domain again keeps the token and the verification, so a
   * double click does not invalidate a TXT record already published.
   */
  async setDomain(tenantId: string, input: unknown): Promise<WebDomainStatus> {
    const domain = normalizeDomain(input);
    if (!domain) {
      throw new BadRequestException(
        "Escribe solo el dominio, por ejemplo reservas.misalon.com (sin https:// ni rutas).",
      );
    }
    if (isPlatformDomain(domain, this.target())) {
      throw new BadRequestException("Ese dominio es de la plataforma. Usa un dominio tuyo.");
    }

    const existing = await this.prisma.customDomain.findFirst({ where: { tenantId } });
    if (existing && existing.domain === domain) return this.getStatus(tenantId);

    const fresh = {
      domain,
      verificationToken: randomBytes(16).toString("hex"),
      verifiedAt: null,
      lastCheckedAt: null,
      lastCheckError: null,
    };
    await this.prisma.customDomain.upsert({
      where: { tenantId },
      create: { tenantId, ...fresh },
      update: fresh,
    });
    return this.getStatus(tenantId);
  }

  async removeDomain(tenantId: string): Promise<WebDomainStatus> {
    await this.prisma.customDomain.deleteMany({ where: { tenantId } });
    return this.getStatus(tenantId);
  }

  /** "Comprobar ahora" in the panel: real DNS lookups. */
  async verify(tenantId: string): Promise<WebDomainStatus> {
    const row = await this.prisma.customDomain.findFirst({ where: { tenantId } });
    if (!row) throw new BadRequestException("Primero indica tu dominio.");
    await this.check(row, { manual: true });
    return this.getStatus(tenantId);
  }

  /**
   * Re-check every verified domain once a day. A domain that changes hands
   * or is repointed elsewhere must stop serving this salon's page; the new
   * owner might point it at us for a different salon.
   *
   * One failed lookup could be a resolver hiccup, so a domain is
   * un-verified only when two consecutive daily checks fail.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async recheckVerified(): Promise<void> {
    const rows = await runUnscoped(() =>
      this.prisma.customDomain.findMany({ where: { verifiedAt: { not: null } } }),
    );
    for (const row of rows) {
      try {
        await this.check(row, { manual: false });
      } catch (err) {
        this.logger.warn(`Custom domain recheck failed for ${row.domain}: ${(err as Error).message}`);
      }
    }
  }

  private async check(
    row: {
      id: string;
      tenantId: string;
      domain: string;
      verificationToken: string;
      verifiedAt: Date | null;
      lastCheckError: string | null;
    },
    { manual }: { manual: boolean },
  ): Promise<void> {
    const now = new Date();
    const result = await checkDomainDns(this.dns, row.domain, row.verificationToken, this.target());

    if (result.ok) {
      // Cross-tenant on purpose: whoever proves ownership now takes the
      // domain from any other salon that had verified it before.
      await runUnscoped(() =>
        this.prisma.$transaction([
          this.prisma.customDomain.updateMany({
            where: { domain: row.domain, id: { not: row.id }, verifiedAt: { not: null } },
            data: {
              verifiedAt: null,
              lastCheckedAt: now,
              lastCheckError: "Otro salón ha demostrado ser el titular de este dominio.",
            },
          }),
          this.prisma.customDomain.update({
            where: { id: row.id },
            data: { verifiedAt: row.verifiedAt ?? now, lastCheckedAt: now, lastCheckError: null },
          }),
        ]),
      );
      return;
    }

    const failedBefore = row.lastCheckError !== null;
    const unverify = row.verifiedAt !== null && !manual && failedBefore;
    await runUnscoped(() =>
      this.prisma.customDomain.update({
        where: { id: row.id },
        data: {
          lastCheckedAt: now,
          lastCheckError: result.error ?? "La comprobación DNS falló.",
          ...(unverify ? { verifiedAt: null } : {}),
        },
      }),
    );
    if (unverify) {
      this.logger.warn(`Custom domain ${row.domain} un-verified after two failed checks: ${result.error}`);
    }
  }
}
